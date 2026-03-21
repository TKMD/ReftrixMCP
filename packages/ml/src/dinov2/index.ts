// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DINOv2 visual embedding service exports
 */

export { DINOv2Service, DINOV2_EMBEDDING_DIMENSION, DINOV2_INPUT_SIZE } from "./service.js";
export type { DINOv2ServiceConfig } from "./service.js";

export type {
  DINOv2WorkerInitMessage,
  DINOv2WorkerInferMessage,
  DINOv2WorkerDisposeMessage,
  DINOv2WorkerMessage,
  DINOv2WorkerInitResponse,
  DINOv2WorkerInferResponse,
  DINOv2WorkerDisposeResponse,
  DINOv2WorkerErrorResponse,
  DINOv2WorkerResponse,
} from "./worker-thread-types.js";
