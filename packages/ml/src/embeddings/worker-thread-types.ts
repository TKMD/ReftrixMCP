// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker Thread message types for ONNX embedding inference.
 *
 * Communication protocol between main thread (EmbeddingService) and
 * worker thread (embedding-worker.ts). Messages are serialized via
 * structured clone (MessagePort), so only plain objects and typed arrays
 * are used — no ONNX Session/Tensor objects cross the boundary.
 *
 * @module embeddings/worker-thread-types
 */

// =====================================================
// Main → Worker messages
// =====================================================

/**
 * Initialize the ONNX pipeline in the worker thread.
 */
export interface WorkerInitMessage {
  type: 'init';
  requestId: string;
  config: {
    modelId: string;
    cacheDir: string;
    device: string;
    dtype: string;
    pipelineRecycleThreshold: number;
  };
}

/**
 * Generate embedding for a single prefixed text.
 * The main thread is responsible for adding E5 prefix before sending.
 */
export interface WorkerGenerateMessage {
  type: 'generate';
  requestId: string;
  text: string;
}

/**
 * Generate embeddings for a batch of prefixed texts.
 * The main thread is responsible for adding E5 prefix before sending.
 */
export interface WorkerGenerateBatchMessage {
  type: 'generateBatch';
  requestId: string;
  texts: string[];
}

/**
 * Dispose the ONNX pipeline to free native memory.
 */
export interface WorkerDisposeMessage {
  type: 'dispose';
  requestId: string;
}

/**
 * Terminate the worker thread gracefully.
 */
export interface WorkerTerminateMessage {
  type: 'terminate';
  requestId: string;
}

/**
 * Switch the ONNX execution provider at runtime (e.g. cpu → cuda).
 * Disposes the current pipeline and re-initializes with the new provider.
 */
export interface WorkerSwitchProviderMessage {
  type: 'switch-provider';
  requestId: string;
  provider: 'cpu' | 'cuda';
}

/**
 * Release GPU resources by disposing the pipeline and reverting to CPU.
 * Safe to call even if already on CPU — acts as a no-op dispose.
 */
export interface WorkerReleaseGpuMessage {
  type: 'release-gpu';
  requestId: string;
}

export type WorkerMessage =
  | WorkerInitMessage
  | WorkerGenerateMessage
  | WorkerGenerateBatchMessage
  | WorkerDisposeMessage
  | WorkerTerminateMessage
  | WorkerSwitchProviderMessage
  | WorkerReleaseGpuMessage;

// =====================================================
// Worker → Main messages
// =====================================================

/**
 * Successful response from init.
 */
export interface WorkerInitResponse {
  type: 'init';
  requestId: string;
  success: true;
  loadTimeMs: number;
  /** The resolved ONNX execution provider ('cpu' or 'cuda'). */
  executionProvider: string;
}

/**
 * Successful response from generate.
 * Embedding is a plain number[] (structured clone compatible).
 */
export interface WorkerGenerateResponse {
  type: 'generate';
  requestId: string;
  success: true;
  embedding: number[];
  inferenceTimeMs: number;
}

/**
 * Successful response from generateBatch.
 */
export interface WorkerGenerateBatchResponse {
  type: 'generateBatch';
  requestId: string;
  success: true;
  embeddings: number[][];
  inferenceTimeMs: number;
}

/**
 * Successful response from dispose.
 */
export interface WorkerDisposeResponse {
  type: 'dispose';
  requestId: string;
  success: true;
}

/**
 * Successful response from terminate (sent just before process.exit).
 */
export interface WorkerTerminateResponse {
  type: 'terminate';
  requestId: string;
  success: true;
}

/**
 * Successful response from switch-provider.
 */
export interface WorkerSwitchProviderResponse {
  type: 'switch-provider';
  requestId: string;
  success: true;
  /** The provider now in effect after the switch. */
  provider: 'cpu' | 'cuda';
}

/**
 * Successful response from release-gpu.
 */
export interface WorkerReleaseGpuResponse {
  type: 'release-gpu';
  requestId: string;
  success: true;
}

/**
 * Error response for any message type.
 */
export interface WorkerErrorResponse {
  type: 'error';
  requestId: string;
  success: false;
  error: string;
  originalType: WorkerMessage['type'];
}

export type WorkerResponse =
  | WorkerInitResponse
  | WorkerGenerateResponse
  | WorkerGenerateBatchResponse
  | WorkerDisposeResponse
  | WorkerTerminateResponse
  | WorkerSwitchProviderResponse
  | WorkerReleaseGpuResponse
  | WorkerErrorResponse;
