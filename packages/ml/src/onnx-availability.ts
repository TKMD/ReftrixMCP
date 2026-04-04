// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cached availability checker for onnxruntime-node (optionalDependency).
 * When unavailable, ML features degrade gracefully.
 *
 * @module onnx-availability
 */

let _available: boolean | null = null;
let _unavailableReason: string | null = null;

/**
 * Check if onnxruntime-node is available (async, caches result).
 */
export async function isOnnxRuntimeAvailable(): Promise<boolean> {
  if (_available !== null) return _available;
  try {
    await import("onnxruntime-node");
    _available = true;
    _unavailableReason = null;
  } catch {
    _available = false;
    _unavailableReason = "onnxruntime-node is not installed";
  }
  return _available;
}

/**
 * Synchronous check — returns null if not yet probed.
 */
export function isOnnxRuntimeAvailableSync(): boolean | null {
  return _available;
}

/**
 * Returns the reason onnxruntime-node is unavailable, or null if available.
 */
export function getOnnxUnavailableReason(): string | null {
  return _unavailableReason;
}

/**
 * Error thrown when ML features require onnxruntime-node but it is not installed.
 */
export class OnnxRuntimeUnavailableError extends Error {
  constructor(context?: string) {
    super(
      `ML features require onnxruntime-node which is not available. ` +
        `Install with: pnpm add onnxruntime-node` +
        (context ? ` (${context})` : "")
    );
    this.name = "OnnxRuntimeUnavailableError";
  }
}

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type OnnxRuntimeModule = typeof import("onnxruntime-node");

/**
 * Safely import onnxruntime-node with a sanitized error on failure.
 */
export async function safeImportOnnx(): Promise<OnnxRuntimeModule> {
  try {
    return await import("onnxruntime-node");
  } catch {
    throw new OnnxRuntimeUnavailableError();
  }
}

/**
 * For testing: reset cached state.
 */
export function _resetForTesting(): void {
  _available = null;
  _unavailableReason = null;
}
