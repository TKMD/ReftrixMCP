// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ONNX Embedding Worker Thread
 *
 * Runs ONNX inference in a separate thread so CPU-bound inference
 * does not block the main thread's event loop. This allows BullMQ
 * heartbeats, IPC messages, and other async operations to proceed
 * while inference is in progress.
 *
 * Architecture:
 * - Main thread sends prefixed texts via parentPort messages.
 * - This worker owns the entire ONNX pipeline lifecycle
 *   (init, inference, recycle, dispose).
 * - Results are sent back as plain number[][] (structured clone safe).
 * - ONNX Session/Tensor objects never cross thread boundaries.
 *
 * @module embeddings/worker-thread
 */

import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import nodePath from 'node:path';
import type {
  WorkerMessage,
  WorkerResponse,
  WorkerErrorResponse,
} from './worker-thread-types.js';

// =====================================================
// Pipeline types (mirrors service.ts DisposablePipeline)
// =====================================================

interface DisposablePipeline {
  (
    texts: string | string[],
    options?: { pooling?: string; normalize?: boolean }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any>;
  dispose?: () => Promise<unknown[]>;
}

// =====================================================
// GPU execution provider detection
// =====================================================

type ExecutionProvider = 'cpu' | 'cuda';

/**
 * Detect the ONNX execution provider based on environment configuration.
 *
 * Checks ONNX_EXECUTION_PROVIDER env var and verifies that the CUDA
 * provider shared library is available on disk. Falls back to CPU
 * gracefully if the provider is not installed.
 */
function detectExecutionProvider(): ExecutionProvider {
  const envProvider = process.env.ONNX_EXECUTION_PROVIDER;

  if (envProvider === 'cuda' || envProvider === 'rocm') {
    const cudaAvailable = verifyCudaAvailability();
    if (cudaAvailable) {
      return 'cuda';
    }
    console.warn(
      '[EmbeddingWorker] ONNX_EXECUTION_PROVIDER=%s but CUDA provider not available, falling back to CPU',
      envProvider,
    );
    return 'cpu';
  }

  return 'cpu';
}

/**
 * Verify that CUDA provider (libonnxruntime_providers_cuda.so) is available.
 *
 * onnxruntime-node can download the CUDA provider shared library via
 * `ONNXRUNTIME_NODE_INSTALL_CUDA=v12 node .../install.js`. This function
 * checks for its presence on disk rather than trying to resolve a
 * non-existent npm package (onnxruntime-gpu is Python-only).
 */
function verifyCudaAvailability(): boolean {
  try {
    const esmRequire = createRequire(import.meta.url);
    const ortNodePath = esmRequire.resolve('onnxruntime-node');
    // require.resolve returns e.g. .../onnxruntime-node/dist/index.js
    // Walk up to package root by finding the directory containing package.json
    let packageDir = nodePath.dirname(ortNodePath);
    for (let i = 0; i < 5; i++) {
      if (fs.existsSync(nodePath.join(packageDir, 'package.json'))) break;
      packageDir = nodePath.dirname(packageDir);
    }

    // Search across napi versions (v3, v6, etc.) for CUDA provider
    const binDir = nodePath.join(packageDir, 'bin');
    if (fs.existsSync(binDir)) {
      const napiDirs = fs.readdirSync(binDir).filter(d => d.startsWith('napi-v'));
      for (const napiDir of napiDirs) {
        const cudaProviderPath = nodePath.join(
          binDir, napiDir, 'linux', 'x64',
          'libonnxruntime_providers_cuda.so',
        );
        if (fs.existsSync(cudaProviderPath)) {
          return true;
        }
      }
    }

    console.warn(
      '[EmbeddingWorker] CUDA provider not found in: %s',
      binDir,
    );
    return false;
  } catch {
    console.warn('[EmbeddingWorker] Cannot verify CUDA provider: onnxruntime-node not found');
    return false;
  }
}

// =====================================================
// Worker state
// =====================================================

let pipeline: DisposablePipeline | null = null;
let initPromise: Promise<void> | null = null;
let inferencesSinceRecycle = 0;
let totalRecycles = 0;
let resolvedProvider: ExecutionProvider = 'cpu';
/** Whether resolvedProvider was explicitly set by a switch-provider message. */
let providerExplicitlySet = false;
let config = {
  modelId: 'Xenova/multilingual-e5-base',
  cacheDir: './.cache/models',
  device: 'cpu',
  dtype: 'fp32',
  pipelineRecycleThreshold: 30,
};

const EMBEDDING_DIMENSION = 768;

// =====================================================
// Pipeline management
// =====================================================

function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  if (norm === 0) return vector;
  return vector.map((val) => val / norm);
}

/**
 * Verify that LD_LIBRARY_PATH is set at the OS level (not just process.env).
 *
 * dlopen() reads LD_LIBRARY_PATH from the kernel environment (/proc/self/environ),
 * NOT from process.env modifications made at runtime. If LD_LIBRARY_PATH was set
 * after process startup (e.g. by loadEnvLocal()), dlopen() cannot find CUDA
 * libraries and ONNX Runtime CUDA provider initialization will segfault or throw.
 *
 * Returns true only if LD_LIBRARY_PATH was present in the original process environment.
 */
function isLdLibraryPathSetAtOsLevel(): boolean {
  try {
    const procEnv = fs.readFileSync('/proc/self/environ', 'utf-8');
    return procEnv.includes('LD_LIBRARY_PATH');
  } catch {
    // /proc/self/environ not available (non-Linux) — assume set
    return true;
  }
}

async function initializePipeline(): Promise<void> {
  if (pipeline) return;
  if (initPromise) return initPromise;

  initPromise = (async (): Promise<void> => {
    try {
      // Only auto-detect from env on first init. If provider was explicitly
      // set by a switch-provider message, respect that setting.
      if (!providerExplicitlySet) {
        resolvedProvider = detectExecutionProvider();
      }

      // Safety check: if CUDA is requested but LD_LIBRARY_PATH was not set at
      // the OS level (only set via loadEnvLocal at runtime), CUDA init will crash
      // because dlopen() can't find CUDA shared libraries. Fall back to CPU.
      if (resolvedProvider === 'cuda' && !isLdLibraryPathSetAtOsLevel()) {
        console.warn(
          '[EmbeddingWorker] CUDA requested but LD_LIBRARY_PATH not set at OS level. ' +
          'dlopen() cannot find CUDA libraries. Falling back to CPU. ' +
          'To use CUDA, set LD_LIBRARY_PATH before starting the Node.js process.'
        );
        resolvedProvider = 'cpu';
      }

      const effectiveDevice = resolvedProvider === 'cuda' ? 'cuda' : config.device;

      // eslint-disable-next-line no-console
      console.log('[EmbeddingWorker] Initializing ONNX pipeline', {
        model: config.modelId,
        requestedDevice: config.device,
        resolvedProvider,
        effectiveDevice,
        dtype: config.dtype,
        recycleThreshold: config.pipelineRecycleThreshold,
      });

      const { pipeline: createPipeline } = await import('@huggingface/transformers');

      // Attempt to create pipeline with the resolved device.
      // If CUDA init fails (e.g. library not found), catch and retry with CPU.
      try {
        pipeline = await createPipeline('feature-extraction', config.modelId, {
          dtype: config.dtype as 'fp32',
          device: effectiveDevice as 'cpu',
        }) as unknown as DisposablePipeline;
      } catch (deviceError) {
        if (effectiveDevice !== 'cpu') {
          // CUDA/GPU init failed — fallback to CPU
          const deviceErrorMsg = deviceError instanceof Error ? deviceError.message : String(deviceError);
          console.warn(
            '[EmbeddingWorker] %s pipeline creation failed, falling back to CPU: %s',
            effectiveDevice,
            deviceErrorMsg,
          );
          resolvedProvider = 'cpu';

          pipeline = await createPipeline('feature-extraction', config.modelId, {
            dtype: config.dtype as 'fp32',
            device: 'cpu',
          }) as unknown as DisposablePipeline;
        } else {
          throw deviceError;
        }
      }

      // eslint-disable-next-line no-console
      console.log('[EmbeddingWorker] ONNX pipeline ready (provider: %s)', resolvedProvider);
    } catch (error) {
      initPromise = null;
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to load embedding model in worker thread: ${message}`);
    }
  })();

  return initPromise;
}

async function disposePipeline(): Promise<void> {
  if (pipeline && typeof pipeline.dispose === 'function') {
    try {
      await pipeline.dispose();
    } catch {
      // Disposal failure should not break the workflow
    }
  }
  pipeline = null;
  initPromise = null;
  inferencesSinceRecycle = 0;
}

async function recyclePipelineIfNeeded(inferenceCount: number): Promise<void> {
  inferencesSinceRecycle += inferenceCount;

  const threshold = config.pipelineRecycleThreshold;
  if (threshold <= 0) return;

  if (inferencesSinceRecycle >= threshold) {
    await disposePipeline();
    totalRecycles++;

    if (typeof global.gc === 'function') {
      global.gc();
    }
  }
}

// =====================================================
// Inference functions
// =====================================================

/**
 * Extract number[] from a pipeline output, disposing the tensor.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractSingleEmbedding(output: any): number[] {
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
    // Non-fatal: warn but continue
  }

  return normalizeVector(embedding);
}

/**
 * Extract number[][] from a batch pipeline output, disposing the tensor.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBatchEmbeddings(output: any): number[][] {
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

  return batchEmbeddings.map(normalizeVector);
}

async function generateSingle(text: string): Promise<number[]> {
  await initializePipeline();
  if (!pipeline) throw new Error('Pipeline not initialized');

  const output = await pipeline(text, { pooling: 'mean', normalize: true });
  const embedding = extractSingleEmbedding(output);

  await recyclePipelineIfNeeded(1);
  return embedding;
}

async function generateBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const BATCH_SIZE = 32;
  const allEmbeddings: number[][] = [];

  for (let batchStart = 0; batchStart < texts.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, texts.length);
    const batch = texts.slice(batchStart, batchEnd);

    // Re-initialize if recycled during previous batch
    await initializePipeline();
    if (!pipeline) throw new Error('Pipeline not initialized after recycle');

    const output = await pipeline(batch, { pooling: 'mean', normalize: true });
    const batchEmbeddings = extractBatchEmbeddings(output);
    allEmbeddings.push(...batchEmbeddings);

    await recyclePipelineIfNeeded(batch.length);
  }

  return allEmbeddings;
}

// =====================================================
// Message handler
// =====================================================

function sendResponse(response: WorkerResponse): void {
  parentPort?.postMessage(response);
}

function sendError(requestId: string, originalType: WorkerMessage['type'], error: unknown): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const response: WorkerErrorResponse = {
    type: 'error',
    requestId,
    success: false,
    error: errorMessage,
    originalType,
  };
  parentPort?.postMessage(response);
}

async function handleMessage(message: WorkerMessage): Promise<void> {
  switch (message.type) {
    case 'init': {
      config = { ...config, ...message.config };
      const startTime = Date.now();
      await initializePipeline();
      sendResponse({
        type: 'init',
        requestId: message.requestId,
        success: true,
        loadTimeMs: Date.now() - startTime,
        executionProvider: resolvedProvider,
      });
      break;
    }

    case 'generate': {
      const startTime = Date.now();
      const embedding = await generateSingle(message.text);
      sendResponse({
        type: 'generate',
        requestId: message.requestId,
        success: true,
        embedding,
        inferenceTimeMs: Date.now() - startTime,
      });
      break;
    }

    case 'generateBatch': {
      const startTime = Date.now();
      const embeddings = await generateBatch(message.texts);
      sendResponse({
        type: 'generateBatch',
        requestId: message.requestId,
        success: true,
        embeddings,
        inferenceTimeMs: Date.now() - startTime,
      });
      break;
    }

    case 'dispose': {
      await disposePipeline();
      sendResponse({
        type: 'dispose',
        requestId: message.requestId,
        success: true,
      });
      break;
    }

    case 'terminate': {
      await disposePipeline();
      sendResponse({
        type: 'terminate',
        requestId: message.requestId,
        success: true,
      });
      // Allow the response to be flushed before exiting
      setTimeout(() => process.exit(0), 50);
      break;
    }

    case 'switch-provider': {
      const targetProvider = message.provider;

      // If switching to CUDA, verify availability first
      if (targetProvider === 'cuda') {
        const canUseCuda = verifyCudaAvailability();
        if (!canUseCuda) {
          // Cannot switch to CUDA — respond with current (cpu) provider
          sendResponse({
            type: 'switch-provider',
            requestId: message.requestId,
            success: true,
            provider: 'cpu',
          });
          break;
        }
      }

      // Dispose current pipeline before switching
      await disposePipeline();

      // Update provider and config — mark as explicitly set so
      // initializePipeline() won't override via detectExecutionProvider()
      resolvedProvider = targetProvider;
      providerExplicitlySet = true;
      config = { ...config, device: targetProvider };

      // eslint-disable-next-line no-console
      console.log('[EmbeddingWorker] Switched provider to:', resolvedProvider);

      sendResponse({
        type: 'switch-provider',
        requestId: message.requestId,
        success: true,
        provider: resolvedProvider,
      });
      break;
    }

    case 'release-gpu': {
      // Dispose pipeline and revert to CPU
      await disposePipeline();
      resolvedProvider = 'cpu';
      providerExplicitlySet = true;
      config = { ...config, device: 'cpu' };

      // eslint-disable-next-line no-console
      console.log('[EmbeddingWorker] Released GPU, reverted to CPU');

      sendResponse({
        type: 'release-gpu',
        requestId: message.requestId,
        success: true,
      });
      break;
    }

    default: {
      // SEC-M2: Reject unknown message types for defense-in-depth
      const unknownType = (message as Record<string, unknown>).type ?? 'unknown';
      sendError(
        (message as Record<string, unknown>).requestId as string ?? 'unknown',
        unknownType as WorkerMessage['type'],
        new Error(`Unknown worker message type: ${String(unknownType)}`),
      );
      break;
    }
  }
}

// =====================================================
// Setup parentPort listener
// =====================================================

if (!parentPort) {
  throw new Error('worker-thread.ts must be run as a Worker Thread (no parentPort)');
}

parentPort.on('message', (message: WorkerMessage) => {
  handleMessage(message).catch((error) => {
    sendError(message.requestId, message.type, error);
  });
});

// Export recycle count for monitoring (accessible via workerData if needed)
export { totalRecycles, inferencesSinceRecycle };
