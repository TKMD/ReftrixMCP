// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker Thread message types for DINOv2 ONNX inference.
 *
 * Communication protocol between main thread (DINOv2Service) and
 * worker thread (worker-thread.ts). Messages are serialized via
 * structured clone (MessagePort), so only plain objects and typed arrays
 * are used -- no ONNX Session/Tensor objects cross the boundary.
 *
 * @module dinov2/worker-thread-types
 */

// =====================================================
// Main -> Worker messages
// =====================================================

/**
 * Initialize the ONNX InferenceSession in the worker thread.
 */
export interface DINOv2WorkerInitMessage {
  type: 'init';
  requestId: string;
  modelPath: string;
}

/**
 * Run DINOv2 inference on a preprocessed image buffer.
 * The main thread sends raw 224x224x3 RGB pixel data.
 */
export interface DINOv2WorkerInferMessage {
  type: 'infer';
  requestId: string;
  imageBuffer: ArrayBuffer; // 224x224x3 RGB raw pixels
  width: number;
  height: number;
}

/**
 * Dispose the ONNX session to free native memory.
 */
export interface DINOv2WorkerDisposeMessage {
  type: 'dispose';
  requestId: string;
}

export type DINOv2WorkerMessage =
  | DINOv2WorkerInitMessage
  | DINOv2WorkerInferMessage
  | DINOv2WorkerDisposeMessage;

// =====================================================
// Worker -> Main messages
// =====================================================

/**
 * Successful response from init.
 */
export interface DINOv2WorkerInitResponse {
  type: 'init';
  requestId: string;
  success: true;
  loadTimeMs: number;
}

/**
 * Successful response from infer.
 * Embedding is a plain number[] (structured clone compatible).
 */
export interface DINOv2WorkerInferResponse {
  type: 'infer';
  requestId: string;
  success: true;
  embedding: number[]; // 768D, L2 normalized
  inferenceTimeMs: number;
}

/**
 * Successful response from dispose.
 */
export interface DINOv2WorkerDisposeResponse {
  type: 'dispose';
  requestId: string;
  success: true;
}

/**
 * Error response for any message type.
 */
export interface DINOv2WorkerErrorResponse {
  type: 'error';
  requestId: string;
  success: false;
  error: string;
  originalType: DINOv2WorkerMessage['type'];
}

export type DINOv2WorkerResponse =
  | DINOv2WorkerInitResponse
  | DINOv2WorkerInferResponse
  | DINOv2WorkerDisposeResponse
  | DINOv2WorkerErrorResponse;
