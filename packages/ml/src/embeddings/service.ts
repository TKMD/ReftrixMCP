// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Service
 *
 * Generates embeddings using multilingual-e5-base model via Transformers.js.
 * Supports both single and batch embedding generation with caching.
 *
 * v0.1.0: ONNX inference runs in a Worker Thread to prevent CPU-bound
 * blocking of the main event loop. The main thread manages the LRU cache,
 * E5 prefix logic, and normalization; the worker thread owns the ONNX
 * pipeline lifecycle (init, inference, recycle, dispose).
 *
 * Set env EMBEDDING_WORKER_THREAD=false to disable worker thread and
 * run inference in-process (legacy behavior, for testing or debugging).
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type {
  EmbeddingTextType,
  EmbeddingServiceConfig,
  CacheStats,
} from './types.js';
import type {
  WorkerMessage,
  WorkerResponse,
} from './worker-thread-types.js';

/**
 * Disposable pipeline interface (used only in in-process fallback mode).
 *
 * The transformers.js Pipeline class exposes a dispose() method that
 * calls model.dispose() which iterates all ONNX sessions and calls
 * session.handler.dispose(). In onnxruntime-node, this tears down the
 * C++ InferenceSession and frees the arena allocator's native memory.
 */
interface DisposablePipeline {
  (
    texts: string | string[],
    options?: { pooling?: string; normalize?: boolean }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any>;
  dispose?: () => Promise<unknown[]>;
}

/**
 * Default maximum cache size for LRU cache
 * Prevents unbounded memory growth
 */
export const DEFAULT_MAX_CACHE_SIZE = 5000;

/**
 * Default number of inferences before recycling the ONNX pipeline.
 *
 * onnxruntime-node uses a native C++ arena allocator that grows monotonically
 * during inference (~65-100MB per inference) but never returns memory to the OS.
 * Pipeline recycling (dispose + recreate) tears down the InferenceSession via
 * session.release(), which frees the arena's native memory back to the OS.
 *
 * With threshold=10, the arena is reset every 10 inferences, keeping peak
 * additional native memory to ~650MB-1GB before each recycle. Model reload
 * takes ~1.5-2s per recycle.
 *
 * v0.1.0: Reduced from 20 to 10 for universal embedding chunking.
 * v0.1.0: Increased from 10 to 30 — chunking already limits items per chunk
 * to 30, so threshold=30 means at most 1 recycle per chunk. With threshold=10,
 * 3 recycles occurred per chunk, and model reload (~1.5-2s each) caused
 * re-initialization overhead of ~45%. threshold=30 aligns with chunk size.
 *
 * Note: This project uses onnxruntime-node (native C++ bindings), NOT WASM.
 * dispose() correctly frees native memory unlike WASM backing store pages.
 */
export const DEFAULT_PIPELINE_RECYCLE_THRESHOLD = 30;

/**
 * Maximum number of automatic worker thread restarts after crash.
 * After this limit is reached, subsequent inference calls will throw.
 */
const MAX_WORKER_RESTARTS = 5;

/**
 * Timeout for worker thread responses (ms).
 * Covers model loading (~15s) + inference (~5s). Set generously to avoid
 * false timeouts on cold start or large batches.
 */
const WORKER_RESPONSE_TIMEOUT_MS = 120_000;

// Default configuration
const DEFAULT_CONFIG: Required<EmbeddingServiceConfig> = {
  modelId: 'Xenova/multilingual-e5-base',
  cacheDir: process.env.MODEL_CACHE_DIR || './.cache/models',
  device: 'cpu',
  dtype: 'fp32',
  maxCacheSize: DEFAULT_MAX_CACHE_SIZE,
  pipelineRecycleThreshold: process.env.PIPELINE_RECYCLE_THRESHOLD !== undefined
    ? parseInt(process.env.PIPELINE_RECYCLE_THRESHOLD, 10)
    : DEFAULT_PIPELINE_RECYCLE_THRESHOLD,
};

// E5 model prefixes for query and passage
const E5_PREFIX = {
  query: 'query: ',
  passage: 'passage: ',
} as const;

// Embedding dimension for multilingual-e5-base
const EMBEDDING_DIMENSION = 768;

/**
 * Whether to use worker thread for ONNX inference.
 * Disabled by env var EMBEDDING_WORKER_THREAD=false or in test environments.
 */
function isWorkerThreadEnabled(): boolean {
  const envVal = process.env.EMBEDDING_WORKER_THREAD;
  if (envVal === 'false' || envVal === '0') return false;
  // Disable in Vitest to avoid worker thread complications in test harness
  if (process.env.VITEST === 'true' || process.env.VITEST_WORKER_ID !== undefined) return false;
  return true;
}

/**
 * Generate a unique request ID for worker thread message correlation.
 */
let requestIdCounter = 0;
function generateRequestId(): string {
  return `req_${Date.now()}_${++requestIdCounter}`;
}

/**
 * Resolve the path to the worker thread script.
 * Uses import.meta.url for ESM compatibility.
 */
function resolveWorkerScriptPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, 'worker-thread.js');
}

/**
 * Normalize a vector to unit length (L2 normalization)
 */
function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  if (norm === 0) return vector;
  return vector.map((val) => val / norm);
}

/**
 * Calculate cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same dimension');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const aVal = a[i];
    const bVal = b[i];
    if (aVal === undefined || bVal === undefined) continue;
    dotProduct += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) return 0;

  return dotProduct / (normA * normB);
}

// =====================================================
// Pending request tracking for worker thread
// =====================================================

interface PendingRequest {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// =====================================================
// EmbeddingService
// =====================================================

/**
 * EmbeddingService - Generates embeddings using multilingual-e5-base
 *
 * v0.1.0: ONNX inference is offloaded to a Worker Thread by default.
 * The main thread retains the LRU cache and E5 prefix logic. Only the
 * actual ONNX pipeline.call() runs in the worker, keeping the main
 * event loop responsive for BullMQ heartbeats and IPC messages.
 */
export class EmbeddingService {
  private config: Required<EmbeddingServiceConfig>;
  private cache: Map<string, number[]> = new Map();
  private cacheHits = 0;
  private cacheMisses = 0;
  private cacheEvictions = 0;

  // --- Worker Thread state ---
  private useWorkerThread: boolean;
  private worker: Worker | null = null;
  private workerInitPromise: Promise<void> | null = null;
  private workerReady = false;
  private workerRestartCount = 0;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  /** Timestamp of last worker crash, used to enforce cooldown between restarts. */
  private lastCrashTime = 0;

  // --- Provider tracking ---
  private currentProvider: 'cpu' | 'cuda' = 'cpu';

  // --- In-process fallback state (legacy) ---
  private pipeline: DisposablePipeline | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Number of inference calls since the last pipeline recycle.
   * In worker-thread mode, the worker manages its own counter.
   * In fallback mode, this counter is used directly.
   */
  private inferencesSinceRecycle = 0;

  /**
   * Total number of pipeline recycles performed during this service's lifetime.
   * In worker-thread mode, the count is approximate (tracked by dispose calls).
   */
  private totalRecycles = 0;

  constructor(config: EmbeddingServiceConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Apply ONNX_EXECUTION_PROVIDER env var if device not explicitly set
    if (!config.device) {
      const envProvider = process.env.ONNX_EXECUTION_PROVIDER;
      if (envProvider === 'cuda' || envProvider === 'rocm') {
        this.config.device = 'cuda';
      }
    }

    this.useWorkerThread = isWorkerThreadEnabled();
    this.currentProvider = this.config.device === 'cuda' ? 'cuda' : 'cpu';

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[ML] EmbeddingService created with config:', {
        modelId: this.config.modelId,
        device: this.config.device,
        dtype: this.config.dtype,
        maxCacheSize: this.config.maxCacheSize,
        pipelineRecycleThreshold: this.config.pipelineRecycleThreshold,
        workerThread: this.useWorkerThread,
      });
    }
  }

  // =====================================================
  // Worker Thread management
  // =====================================================

  /**
   * Spawn the worker thread and send init message.
   * Enforces a cooldown after crashes to prevent rapid spawn-crash-spawn cycles
   * that consume memory (~10GB per CUDA init attempt).
   */
  private async ensureWorkerReady(): Promise<void> {
    if (this.workerReady && this.worker) return;
    if (this.workerInitPromise) return this.workerInitPromise;

    // Cooldown: wait at least 3s after a crash before attempting restart.
    // This prevents rapid spawn-crash cycles from consuming all system memory.
    if (this.lastCrashTime > 0) {
      const CRASH_COOLDOWN_MS = 3_000;
      const elapsed = Date.now() - this.lastCrashTime;
      if (elapsed < CRASH_COOLDOWN_MS) {
        const waitMs = CRASH_COOLDOWN_MS - elapsed;
        if (process.env.NODE_ENV === 'development') {
          // eslint-disable-next-line no-console
          console.log('[ML] Waiting %dms before Worker Thread restart (crash cooldown)', waitMs);
        }
        await new Promise<void>(resolve => setTimeout(resolve, waitMs));
      }
    }

    this.workerInitPromise = this.spawnAndInitWorker();
    return this.workerInitPromise;
  }

  private async spawnAndInitWorker(): Promise<void> {
    try {
      const scriptPath = resolveWorkerScriptPath();

      if (process.env.NODE_ENV === 'development') {
        // eslint-disable-next-line no-console
        console.log('[ML] Spawning ONNX Worker Thread:', scriptPath);
      }

      // Pass allowed V8 flags to worker thread.
      // NOTE: --expose-gc is NOT allowed in Worker threads (Node.js rejects it).
      // Workers can still use global.gc if the MAIN thread was started with --expose-gc.
      const execArgv = process.execArgv.filter(
        arg => arg.startsWith('--max-old-space-size')
      );

      this.worker = new Worker(scriptPath, { execArgv: execArgv.length > 0 ? execArgv : undefined });

      // Handle worker messages
      this.worker.on('message', (response: WorkerResponse) => {
        this.handleWorkerResponse(response);
      });

      // Handle worker errors
      this.worker.on('error', (error: Error) => {
        if (process.env.NODE_ENV === 'development') {
          console.warn('[ML] Worker Thread error:', error.message);
        }
        this.handleWorkerCrash(error);
      });

      // Handle worker exit
      this.worker.on('exit', (code: number) => {
        if (code !== 0) {
          if (process.env.NODE_ENV === 'development') {
            console.warn('[ML] Worker Thread exited with code:', code);
          }
          this.handleWorkerCrash(new Error(`Worker thread exited with code ${code}`));
        }
        this.workerReady = false;
        this.worker = null;
      });

      // Send init message and wait for response
      const response = await this.sendWorkerMessage({
        type: 'init',
        requestId: generateRequestId(),
        config: {
          modelId: this.config.modelId,
          cacheDir: this.config.cacheDir,
          device: this.config.device,
          dtype: this.config.dtype,
          pipelineRecycleThreshold: this.config.pipelineRecycleThreshold,
        },
      });

      if (response.type === 'error') {
        throw new Error(`Worker init failed: ${response.error}`);
      }

      this.workerReady = true;

      if (response.type === 'init') {
        this.currentProvider = response.executionProvider === 'cuda' ? 'cuda' : 'cpu';
        // eslint-disable-next-line no-console
        console.log('[ML] Worker Thread initialized in %dms (provider: %s)',
          response.loadTimeMs,
          response.executionProvider,
        );
      }
    } catch (error) {
      this.workerInitPromise = null;
      this.workerReady = false;
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to initialize ONNX Worker Thread: ${message}`);
    }
  }

  /**
   * Send a message to the worker and return a Promise for the response.
   */
  private sendWorkerMessage(message: WorkerMessage): Promise<WorkerResponse> {
    if (!this.worker) {
      return Promise.reject(new Error('Worker thread not available'));
    }

    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(message.requestId);
        reject(new Error(`Worker thread response timeout (${WORKER_RESPONSE_TIMEOUT_MS}ms) for ${message.type}`));
      }, WORKER_RESPONSE_TIMEOUT_MS);

      this.pendingRequests.set(message.requestId, { resolve, reject, timer });
      this.worker!.postMessage(message);
    });
  }

  /**
   * Route a response from the worker to the pending request's promise.
   */
  private handleWorkerResponse(response: WorkerResponse): void {
    const pending = this.pendingRequests.get(response.requestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRequests.delete(response.requestId);
    pending.resolve(response);
  }

  /**
   * Handle worker thread crash: reject all pending requests, attempt restart.
   */
  private handleWorkerCrash(error: Error): void {
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Worker thread crashed: ${error.message}`));
      this.pendingRequests.delete(id);
    }

    this.workerReady = false;
    this.worker = null;
    this.workerInitPromise = null;
    this.workerRestartCount++;
    this.lastCrashTime = Date.now();

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[ML] Worker Thread crash, restart count:', this.workerRestartCount);
    }
  }

  /**
   * Check if the worker can be restarted (under max restart limit).
   */
  private canRestartWorker(): boolean {
    return this.workerRestartCount < MAX_WORKER_RESTARTS;
  }

  // =====================================================
  // In-process fallback (legacy mode)
  // =====================================================

  /**
   * Initialize the in-process embedding pipeline (lazy loading).
   * Used when worker thread is disabled.
   *
   * If the configured device is 'cuda' but initialization fails (e.g. because
   * LD_LIBRARY_PATH was not set at the OS level), automatically falls back to CPU.
   */
  private async initializeInProcess(): Promise<void> {
    if (this.pipeline) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async (): Promise<void> => {
      try {
        if (process.env.NODE_ENV === 'development') {
          // eslint-disable-next-line no-console
          console.log('[ML] Loading embedding model (in-process):', this.config.modelId, '(device:', this.config.device + ')');
        }

        const startTime = Date.now();
        const { pipeline } = await import('@huggingface/transformers');

        try {
          this.pipeline = await pipeline('feature-extraction', this.config.modelId, {
            dtype: this.config.dtype,
            device: this.config.device,
          }) as unknown as DisposablePipeline;
        } catch (deviceError) {
          if (this.config.device !== 'cpu') {
            const msg = deviceError instanceof Error ? deviceError.message : String(deviceError);
            console.warn('[ML] %s pipeline creation failed, falling back to CPU: %s', this.config.device, msg);
            this.config = { ...this.config, device: 'cpu' };
            this.currentProvider = 'cpu';

            this.pipeline = await pipeline('feature-extraction', this.config.modelId, {
              dtype: this.config.dtype,
              device: 'cpu',
            }) as unknown as DisposablePipeline;
          } else {
            throw deviceError;
          }
        }

        const loadTime = Date.now() - startTime;

        if (process.env.NODE_ENV === 'development') {
          // eslint-disable-next-line no-console
          console.log('[ML] Model loaded in-process in', loadTime, 'ms (provider:', this.currentProvider + ')');
        }
      } catch (error) {
        this.initPromise = null;
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Failed to load embedding model: ${message}`);
      }
    })();

    return this.initPromise;
  }

  /**
   * Recycle the in-process pipeline if threshold reached.
   */
  private async recyclePipelineIfNeeded(inferenceCount: number): Promise<void> {
    this.inferencesSinceRecycle += inferenceCount;

    const threshold = this.config.pipelineRecycleThreshold;
    if (threshold <= 0) return;

    if (this.inferencesSinceRecycle >= threshold) {
      if (process.env.NODE_ENV === 'development') {
        // eslint-disable-next-line no-console
        console.log('[ML] Pipeline recycle threshold reached', {
          inferencesSinceRecycle: this.inferencesSinceRecycle,
          threshold,
          totalRecycles: this.totalRecycles,
        });
      }

      await this.disposeInProcess();
      this.totalRecycles++;

      if (typeof global.gc === 'function') {
        global.gc();
      }

      if (process.env.NODE_ENV === 'development') {
        // eslint-disable-next-line no-console
        console.log('[ML] Pipeline recycled successfully', {
          totalRecycles: this.totalRecycles,
        });
      }
    }
  }

  /**
   * Dispose the in-process pipeline.
   */
  private async disposeInProcess(): Promise<void> {
    if (this.pipeline && typeof this.pipeline.dispose === 'function') {
      try {
        await this.pipeline.dispose();
      } catch {
        // Disposal failure should not break the workflow
      }
    }
    this.pipeline = null;
    this.initPromise = null;
    this.inferencesSinceRecycle = 0;
  }

  /**
   * Generate a single embedding in-process (fallback).
   */
  private async generateInProcess(prefixedText: string): Promise<number[]> {
    await this.initializeInProcess();
    if (!this.pipeline) throw new Error('Embedding pipeline not initialized');

    const output = await this.pipeline(prefixedText, { pooling: 'mean', normalize: true });

    let embedding: number[];
    if (output && typeof output.tolist === 'function') {
      const result = output.tolist();
      embedding = Array.isArray(result[0]) ? result[0] : result;
      if (typeof output.dispose === 'function') {
        output.dispose();
      }
    } else if (Array.isArray(output)) {
      embedding = output;
    } else {
      throw new Error('Unexpected embedding output format');
    }

    if (embedding.length !== EMBEDDING_DIMENSION) {
      console.warn(`[ML] Warning: Expected ${EMBEDDING_DIMENSION} dimensions, got ${embedding.length}`);
    }

    await this.recyclePipelineIfNeeded(1);
    return normalizeVector(embedding);
  }

  /**
   * Generate batch embeddings in-process (fallback).
   */
  private async generateBatchInProcess(prefixedTexts: string[]): Promise<number[][]> {
    const BATCH_SIZE = 32;
    const allEmbeddings: number[][] = [];

    for (let batchStart = 0; batchStart < prefixedTexts.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, prefixedTexts.length);
      const batch = prefixedTexts.slice(batchStart, batchEnd);

      if (!this.pipeline) {
        await this.initializeInProcess();
        if (!this.pipeline) throw new Error('Embedding pipeline not initialized after recycle');
      }

      const output = await this.pipeline(batch, { pooling: 'mean', normalize: true });

      let batchEmbeddings: number[][];
      if (output && typeof output.tolist === 'function') {
        batchEmbeddings = output.tolist();
        if (typeof output.dispose === 'function') {
          output.dispose();
        }
      } else if (Array.isArray(output)) {
        batchEmbeddings = output;
      } else {
        throw new Error('Unexpected batch embedding output format');
      }

      for (const emb of batchEmbeddings) {
        allEmbeddings.push(normalizeVector(emb));
      }

      await this.recyclePipelineIfNeeded(batch.length);

      // Yield between batches
      if (batchEnd < prefixedTexts.length) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }

    return allEmbeddings;
  }

  // =====================================================
  // Public API
  // =====================================================

  /**
   * Check if the model is initialized (worker thread is ready or pipeline loaded).
   */
  isInitialized(): boolean {
    if (this.useWorkerThread) {
      return this.workerReady;
    }
    return this.pipeline !== null;
  }

  /**
   * Get the total number of pipeline recycles performed.
   */
  getRecycleCount(): number {
    return this.totalRecycles;
  }

  /**
   * Get the number of inferences since the last pipeline recycle.
   * In worker-thread mode this is approximate (tracked via dispose calls).
   */
  getInferencesSinceRecycle(): number {
    return this.inferencesSinceRecycle;
  }

  /**
   * Generate cache key for embedding
   */
  private getCacheKey(text: string, type: EmbeddingTextType): string {
    return `${type}:${text}`;
  }

  /**
   * Set cache entry with LRU eviction
   */
  private setCacheEntry(key: string, value: number[]): void {
    while (this.cache.size >= this.config.maxCacheSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
        this.cacheEvictions++;
        if (process.env.NODE_ENV === 'development') {
          // eslint-disable-next-line no-console
          console.log('[ML] Cache evicted oldest entry, size:', this.cache.size);
        }
      } else {
        break;
      }
    }
    this.cache.set(key, value);
  }

  /**
   * Get cache entry with LRU update (move to end)
   */
  private getCacheEntry(key: string): number[] | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  /**
   * Generate embedding for a single text
   *
   * @param text - Input text to embed
   * @param type - Type of text ('query' or 'passage')
   * @returns 768-dimensional normalized embedding vector
   */
  async generateEmbedding(text: string, type: EmbeddingTextType): Promise<number[]> {
    // Check cache first (with LRU update)
    const cacheKey = this.getCacheKey(text, type);
    const cached = this.getCacheEntry(cacheKey);
    if (cached) {
      this.cacheHits++;
      if (process.env.NODE_ENV === 'development') {
        // eslint-disable-next-line no-console
        console.log('[ML] Cache hit for:', text.substring(0, 30));
      }
      return cached;
    }

    this.cacheMisses++;

    const startTime = Date.now();
    const prefixedText = E5_PREFIX[type] + text;

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[ML] Generating embedding for:', prefixedText.substring(0, 50));
    }

    let embedding: number[];

    if (this.useWorkerThread) {
      embedding = await this.generateViaWorker(prefixedText);
    } else {
      embedding = await this.generateInProcess(prefixedText);
    }

    // Ensure proper dimension
    if (embedding.length !== EMBEDDING_DIMENSION) {
      console.warn(`[ML] Warning: Expected ${EMBEDDING_DIMENSION} dimensions, got ${embedding.length}`);
    }

    // Cache the result
    this.setCacheEntry(cacheKey, embedding);

    const elapsedMs = Date.now() - startTime;
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[ML] Embedding generated in', elapsedMs, 'ms');
    }

    return embedding;
  }

  /**
   * Generate embedding via Worker Thread, with crash recovery.
   */
  private async generateViaWorker(prefixedText: string): Promise<number[]> {
    // Ensure worker is running (spawn + init if needed, or restart after crash)
    if (!this.workerReady || !this.worker) {
      if (!this.canRestartWorker() && this.workerRestartCount > 0) {
        throw new Error(`Worker thread exceeded max restarts (${MAX_WORKER_RESTARTS})`);
      }
      await this.ensureWorkerReady();
    }

    const response = await this.sendWorkerMessage({
      type: 'generate',
      requestId: generateRequestId(),
      text: prefixedText,
    });

    if (response.type === 'error') {
      throw new Error(`Worker inference failed: ${response.error}`);
    }

    if (response.type !== 'generate') {
      throw new Error(`Unexpected worker response type: ${response.type}`);
    }

    return response.embedding;
  }

  /**
   * Generate batch embeddings via Worker Thread, with crash recovery.
   */
  private async generateBatchViaWorker(prefixedTexts: string[]): Promise<number[][]> {
    if (!this.workerReady || !this.worker) {
      if (!this.canRestartWorker() && this.workerRestartCount > 0) {
        throw new Error(`Worker thread exceeded max restarts (${MAX_WORKER_RESTARTS})`);
      }
      await this.ensureWorkerReady();
    }

    const response = await this.sendWorkerMessage({
      type: 'generateBatch',
      requestId: generateRequestId(),
      texts: prefixedTexts,
    });

    if (response.type === 'error') {
      throw new Error(`Worker batch inference failed: ${response.error}`);
    }

    if (response.type !== 'generateBatch') {
      throw new Error(`Unexpected worker response type: ${response.type}`);
    }

    return response.embeddings;
  }

  /**
   * Generate embeddings for multiple texts
   *
   * @param texts - Array of input texts
   * @param type - Type of texts ('query' or 'passage')
   * @returns Array of 768-dimensional normalized embedding vectors
   */
  async generateBatchEmbeddings(
    texts: string[],
    type: EmbeddingTextType
  ): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const startTime = Date.now();

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[ML] Generating batch embeddings for', texts.length, 'texts');
    }

    // Check cache for each text
    const results: (number[] | undefined)[] = new Array(texts.length);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      if (text === undefined) continue;

      const cacheKey = this.getCacheKey(text, type);
      const cached = this.getCacheEntry(cacheKey);
      if (cached) {
        this.cacheHits++;
        results[i] = cached;
      } else {
        this.cacheMisses++;
        uncachedIndices.push(i);
        uncachedTexts.push(text);
      }
    }

    // Generate embeddings for uncached texts
    if (uncachedTexts.length > 0) {
      const prefixedTexts = uncachedTexts.map((text) => E5_PREFIX[type] + text);

      let generatedEmbeddings: number[][];

      if (this.useWorkerThread) {
        generatedEmbeddings = await this.generateBatchViaWorker(prefixedTexts);
      } else {
        generatedEmbeddings = await this.generateBatchInProcess(prefixedTexts);
      }

      // Store results and cache
      for (let j = 0; j < generatedEmbeddings.length; j++) {
        const originalIndex = uncachedIndices[j];
        const embedding = generatedEmbeddings[j];

        if (originalIndex === undefined || embedding === undefined) continue;

        results[originalIndex] = embedding;

        // Cache the result
        const originalText = texts[originalIndex];
        if (originalText !== undefined) {
          const cacheKey = this.getCacheKey(originalText, type);
          this.setCacheEntry(cacheKey, embedding);
        }
      }
    }

    const elapsedMs = Date.now() - startTime;

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[ML] Batch embeddings generated in', elapsedMs, 'ms');
    }

    return results.filter((r): r is number[] => r !== undefined);
  }

  /**
   * Dispose the ONNX pipeline to free native memory.
   *
   * In worker-thread mode, sends a dispose message to the worker.
   * In fallback mode, disposes the in-process pipeline.
   *
   * After disposal, the next inference call will re-initialize automatically.
   */
  async dispose(): Promise<void> {
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[ML] Disposing ONNX pipeline', {
        mode: this.useWorkerThread ? 'worker-thread' : 'in-process',
        inferencesSinceRecycle: this.inferencesSinceRecycle,
        totalRecycles: this.totalRecycles,
      });
    }

    if (this.useWorkerThread) {
      if (this.worker && this.workerReady) {
        try {
          await this.sendWorkerMessage({
            type: 'dispose',
            requestId: generateRequestId(),
          });
        } catch {
          // Disposal failure should not break the workflow
        }
      }
    } else {
      await this.disposeInProcess();
    }

    this.inferencesSinceRecycle = 0;
  }

  /**
   * Terminate the worker thread completely and clean up.
   * After this, the service cannot be used until a new instance is created.
   */
  async terminate(): Promise<void> {
    if (this.worker) {
      try {
        await this.sendWorkerMessage({
          type: 'terminate',
          requestId: generateRequestId(),
        });
      } catch {
        // May fail if worker already exited
      }

      // Force terminate after a grace period
      try {
        await this.worker.terminate();
      } catch {
        // Already terminated
      }

      this.worker = null;
      this.workerReady = false;
      this.workerInitPromise = null;
    }

    // Also dispose in-process pipeline if present
    await this.disposeInProcess();

    // Reject any remaining pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Service terminated'));
      this.pendingRequests.delete(id);
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): CacheStats {
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      size: this.cache.size,
      evictions: this.cacheEvictions,
    };
  }

  /**
   * Clear the embedding cache
   */
  clearCache(): void {
    this.cache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.cacheEvictions = 0;

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[ML] Cache cleared');
    }
  }

  /**
   * Whether this service is using a Worker Thread for inference.
   */
  isUsingWorkerThread(): boolean {
    return this.useWorkerThread;
  }

  /**
   * Get the current ONNX execution provider ('cpu' or 'cuda').
   */
  getCurrentProvider(): 'cpu' | 'cuda' {
    return this.currentProvider;
  }

  /**
   * Switch ONNX execution provider at runtime.
   *
   * In worker-thread mode: sends a switch-provider message to the worker,
   * which disposes the current pipeline and updates the device config.
   * In in-process mode: disposes the pipeline and updates the config
   * so the next inference call re-initializes with the new provider.
   *
   * @param provider - The target execution provider ('cpu' or 'cuda').
   * @returns true if the switch succeeded and the requested provider is now
   *          active; false if the switch was not possible (e.g. CUDA not
   *          available) — in that case the service remains on CPU.
   */
  async switchProvider(provider: 'cpu' | 'cuda'): Promise<boolean> {
    if (provider === this.currentProvider) {
      return true;
    }

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[ML] Switching provider: %s → %s', this.currentProvider, provider);
    }

    if (this.useWorkerThread) {
      return this.switchProviderViaWorker(provider);
    }
    return this.switchProviderInProcess(provider);
  }

  /**
   * Switch provider via Worker Thread message.
   */
  private async switchProviderViaWorker(provider: 'cpu' | 'cuda'): Promise<boolean> {
    if (!this.workerReady || !this.worker) {
      // Worker not running — just update local config. When the worker
      // starts next, it will pick up the new device setting.
      this.config = { ...this.config, device: provider };
      this.currentProvider = provider;
      // For CUDA, we can't verify availability without the worker, so
      // we optimistically set it. The worker's init will fall back to
      // CPU if onnxruntime-gpu is not installed.
      return true;
    }

    const response = await this.sendWorkerMessage({
      type: 'switch-provider',
      requestId: generateRequestId(),
      provider,
    });

    if (response.type === 'error') {
      if (process.env.NODE_ENV === 'development') {
        console.warn('[ML] Provider switch failed:', response.error);
      }
      return false;
    }

    if (response.type === 'switch-provider') {
      this.currentProvider = response.provider;
      this.config = { ...this.config, device: response.provider };
      return response.provider === provider;
    }

    return false;
  }

  /**
   * Switch provider in-process (fallback mode).
   */
  private async switchProviderInProcess(provider: 'cpu' | 'cuda'): Promise<boolean> {
    // For CUDA, verify the CUDA provider shared library is available
    if (provider === 'cuda') {
      try {
        const fs = await import('node:fs');
        const pathMod = await import('node:path');
        const { createRequire } = await import('node:module');
        const require_ = createRequire(import.meta.url);
        const ortNodePath = require_.resolve('onnxruntime-node');
        // Walk up to package root (resolve returns .../dist/index.js)
        let packageDir = pathMod.dirname(ortNodePath);
        for (let i = 0; i < 5; i++) {
          if (fs.existsSync(pathMod.join(packageDir, 'package.json'))) break;
          packageDir = pathMod.dirname(packageDir);
        }

        // Search across napi versions (v3, v6, etc.) for CUDA provider
        let cudaFound = false;
        const binDir = pathMod.join(packageDir, 'bin');
        if (fs.existsSync(binDir)) {
          const napiDirs = fs.readdirSync(binDir).filter((d: string) => d.startsWith('napi-v'));
          for (const napiDir of napiDirs) {
            const p = pathMod.join(binDir, napiDir, 'linux', 'x64', 'libonnxruntime_providers_cuda.so');
            if (fs.existsSync(p)) {
              cudaFound = true;
              break;
            }
          }
        }
        if (!cudaFound) {
          if (process.env.NODE_ENV === 'development') {
            console.warn('[ML] Cannot switch to CUDA in-process: CUDA provider not found');
          }
          return false;
        }
      } catch {
        if (process.env.NODE_ENV === 'development') {
          console.warn('[ML] Cannot switch to CUDA in-process: onnxruntime-node not found');
        }
        return false;
      }
    }

    // Dispose current pipeline so next inference re-inits with new device
    await this.disposeInProcess();
    this.config = { ...this.config, device: provider };
    this.currentProvider = provider;
    return true;
  }

  /**
   * Release GPU resources by disposing the pipeline and switching to CPU.
   *
   * Safe to call even if already on CPU — acts as a dispose + ensures
   * the provider is set to CPU.
   */
  async releaseGpu(): Promise<void> {
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[ML] Releasing GPU resources (current provider: %s)', this.currentProvider);
    }

    if (this.useWorkerThread) {
      await this.releaseGpuViaWorker();
    } else {
      await this.releaseGpuInProcess();
    }
  }

  /**
   * Release GPU via Worker Thread message.
   */
  private async releaseGpuViaWorker(): Promise<void> {
    if (this.worker && this.workerReady) {
      try {
        await this.sendWorkerMessage({
          type: 'release-gpu',
          requestId: generateRequestId(),
        });
      } catch {
        // Release failure should not break the workflow
      }
    }

    this.currentProvider = 'cpu';
    this.config = { ...this.config, device: 'cpu' };
  }

  /**
   * Release GPU in-process (fallback mode).
   */
  private async releaseGpuInProcess(): Promise<void> {
    await this.disposeInProcess();
    this.currentProvider = 'cpu';
    this.config = { ...this.config, device: 'cpu' };
  }

  /**
   * Get the number of worker thread restarts that have occurred.
   */
  getWorkerRestartCount(): number {
    return this.workerRestartCount;
  }
}

// Singleton instance for default usage
export const embeddingService = new EmbeddingService();
