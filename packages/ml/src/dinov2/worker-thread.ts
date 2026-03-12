// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DINOv2 ONNX Worker Thread
 *
 * Runs DINOv2 ViT-B/14 inference in a separate thread so CPU-bound
 * inference does not block the main thread's event loop. This allows
 * BullMQ heartbeats, IPC messages, and other async operations to proceed
 * while inference is in progress.
 *
 * Architecture:
 * - Main thread sends preprocessed 224x224 RGB pixel buffers via parentPort.
 * - This worker owns the ONNX InferenceSession lifecycle (init, inference, dispose).
 * - Results are sent back as plain number[] (structured clone safe).
 * - ONNX Session/Tensor objects never cross thread boundaries.
 *
 * Uses onnxruntime-node InferenceSession directly (not transformers.js pipeline).
 *
 * @module dinov2/worker-thread
 */

import { parentPort } from 'node:worker_threads';
import type {
  DINOv2WorkerMessage,
  DINOv2WorkerResponse,
  DINOv2WorkerErrorResponse,
} from './worker-thread-types.js';

// =====================================================
// Dynamic import of onnxruntime-node
// =====================================================

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type OrtModule = typeof import('onnxruntime-node');
let ort: OrtModule | null = null;

async function getOrt(): Promise<OrtModule> {
  if (!ort) {
    ort = await import('onnxruntime-node');
  }
  return ort;
}

// =====================================================
// Worker state
// =====================================================

/**
 * ONNX InferenceSession interface (subset used by this worker).
 * We avoid InstanceType<> on InferenceSession because it's a factory, not a class.
 */
interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: readonly number[] }>>;
  release(): Promise<void>;
}

let session: OrtSession | null = null;

const DINOV2_EMBEDDING_DIMENSION = 768;

// ImageNet normalization constants
const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGENET_STD = [0.229, 0.224, 0.225] as const;

// =====================================================
// Preprocessing functions
// =====================================================

/**
 * Preprocess raw RGB pixel buffer into DINOv2 input tensor format.
 *
 * Converts HWC (height-width-channel) uint8 pixels to CHW (channel-height-width)
 * float32 with ImageNet normalization: (pixel/255 - mean) / std
 *
 * @param rawPixels - Raw 224x224x3 RGB pixel buffer
 * @param width - Image width (expected: 224)
 * @param height - Image height (expected: 224)
 * @returns Float32Array in [1, 3, H, W] layout (flattened)
 */
function preprocessImage(rawPixels: ArrayBuffer, width: number, height: number): Float32Array {
  const pixels = new Uint8Array(rawPixels);
  const expectedSize = width * height * 3;
  if (pixels.length !== expectedSize) {
    throw new Error(`Invalid buffer size: expected ${expectedSize}, got ${pixels.length}`);
  }

  const float32 = new Float32Array(3 * width * height);

  // HWC -> CHW with ImageNet normalization
  for (let c = 0; c < 3; c++) {
    const mean = IMAGENET_MEAN[c]!;
    const std = IMAGENET_STD[c]!;
    for (let h = 0; h < height; h++) {
      for (let w = 0; w < width; w++) {
        const srcIdx = (h * width + w) * 3 + c;
        const dstIdx = c * height * width + h * width + w;
        float32[dstIdx] = (pixels[srcIdx]! / 255.0 - mean) / std;
      }
    }
  }
  return float32;
}

/**
 * L2 normalize a vector to unit length.
 *
 * Validates all elements are finite numbers (NaN/Infinity defense [H-3]).
 * Throws on zero vector to prevent degenerate embeddings in pgvector.
 *
 * @param vec - Input vector
 * @returns L2-normalized vector
 */
function l2Normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i]!;
    if (!Number.isFinite(v)) {
      throw new Error(`NaN/Infinity detected at index ${i}`);
    }
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  if (norm === 0) {
    throw new Error('Zero vector: L2 norm is 0');
  }
  const result = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    result[i] = vec[i]! / norm;
  }
  return result;
}

// =====================================================
// Session management
// =====================================================

async function initializeSession(modelPath: string): Promise<void> {
  if (session) return;

  const ortModule = await getOrt();
  session = await ortModule.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
  }) as unknown as OrtSession;

  // eslint-disable-next-line no-console
  console.log('[DINOv2Worker] Session initialized:', modelPath);
}

async function disposeSession(): Promise<void> {
  if (session) {
    try {
      await session.release();
    } catch {
      // Disposal failure should not break the workflow
    }
    session = null;
  }
}

/**
 * Run DINOv2 inference on preprocessed image data.
 *
 * Input: pixel_values tensor [1, 3, 224, 224]
 * Output: last_hidden_state [1, 257, 768] -> CLS token [768] -> L2 normalized
 *
 * The 257 tokens = 1 CLS token + 256 patch tokens (14x14 patches from 224x224 image, 16px each).
 */
async function runInference(
  rawPixels: ArrayBuffer,
  width: number,
  height: number,
): Promise<number[]> {
  if (!session) {
    throw new Error('DINOv2 session not initialized');
  }

  const ortModule = await getOrt();

  // Preprocess: HWC uint8 -> CHW float32 with ImageNet normalization
  const inputData = preprocessImage(rawPixels, width, height);

  // Create input tensor [1, 3, height, width]
  const inputTensor = new ortModule.Tensor('float32', inputData, [1, 3, height, width]);

  // Run inference
  const output = await session.run({ pixel_values: inputTensor });

  // Extract CLS token from last_hidden_state [1, 257, 768]
  const lastHiddenState = output.last_hidden_state;
  if (!lastHiddenState) {
    throw new Error('Model output missing last_hidden_state');
  }

  const data = lastHiddenState.data as Float32Array;
  const dims = lastHiddenState.dims as readonly number[];

  // Validate output shape: [1, 257, 768]
  if (dims.length !== 3 || dims[2] !== DINOV2_EMBEDDING_DIMENSION) {
    throw new Error(
      `Unexpected output shape: [${dims.join(', ')}], expected [1, 257, ${DINOV2_EMBEDDING_DIMENSION}]`,
    );
  }

  // Extract CLS token (first token, index 0)
  const clsToken = new Float32Array(DINOV2_EMBEDDING_DIMENSION);
  for (let i = 0; i < DINOV2_EMBEDDING_DIMENSION; i++) {
    clsToken[i] = data[i]!;
  }

  // L2 normalize with NaN/Infinity defense
  const normalized = l2Normalize(clsToken);

  // Convert to plain number[] for structured clone
  return Array.from(normalized);
}

// =====================================================
// Message handler
// =====================================================

function sendResponse(response: DINOv2WorkerResponse): void {
  parentPort?.postMessage(response);
}

function sendError(requestId: string, originalType: DINOv2WorkerMessage['type'], error: unknown): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const response: DINOv2WorkerErrorResponse = {
    type: 'error',
    requestId,
    success: false,
    error: errorMessage,
    originalType,
  };
  parentPort?.postMessage(response);
}

async function handleMessage(message: DINOv2WorkerMessage): Promise<void> {
  switch (message.type) {
    case 'init': {
      const startTime = Date.now();
      await initializeSession(message.modelPath);
      sendResponse({
        type: 'init',
        requestId: message.requestId,
        success: true,
        loadTimeMs: Date.now() - startTime,
      });
      break;
    }

    case 'infer': {
      const startTime = Date.now();
      const embedding = await runInference(message.imageBuffer, message.width, message.height);
      sendResponse({
        type: 'infer',
        requestId: message.requestId,
        success: true,
        embedding,
        inferenceTimeMs: Date.now() - startTime,
      });
      break;
    }

    case 'dispose': {
      await disposeSession();
      sendResponse({
        type: 'dispose',
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
        unknownType as DINOv2WorkerMessage['type'],
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
  throw new Error('dinov2/worker-thread.ts must be run as a Worker Thread (no parentPort)');
}

parentPort.on('message', (message: DINOv2WorkerMessage) => {
  handleMessage(message).catch((error) => {
    sendError(message.requestId, message.type, error);
  });
});
