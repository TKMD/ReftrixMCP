// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ONNX Execution Provider Detection Utilities
 *
 * Shared logic for detecting the ONNX execution provider (CPU vs CUDA)
 * based on environment configuration and CUDA shared library availability.
 *
 * Used by both the e5-base embedding worker thread and the DINOv2 worker thread
 * to avoid code duplication. Extracted from embeddings/worker-thread.ts in v0.4.0.
 *
 * @module onnx-provider-detect
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import nodePath from "node:path";

// =====================================================
// Types
// =====================================================

export type ExecutionProvider = "cpu" | "cuda";

// =====================================================
// Provider Detection
// =====================================================

/**
 * Detect the ONNX execution provider based on environment configuration.
 *
 * Checks ONNX_EXECUTION_PROVIDER env var and verifies that the CUDA
 * provider shared library is available on disk. Falls back to CPU
 * gracefully if the provider is not installed.
 *
 * @param logPrefix - Log prefix for warning messages (e.g. "EmbeddingWorker", "DINOv2Worker")
 */
export function detectExecutionProvider(logPrefix?: string): ExecutionProvider {
  const prefix = logPrefix ?? "OnnxProvider";
  const envProvider = process.env.ONNX_EXECUTION_PROVIDER;

  if (envProvider === "cuda" || envProvider === "rocm") {
    const cudaAvailable = verifyCudaAvailability(logPrefix);
    if (cudaAvailable) {
      return "cuda";
    }
    console.warn(
      "[%s] ONNX_EXECUTION_PROVIDER=%s but CUDA provider not available, falling back to CPU",
      prefix,
      envProvider
    );
    return "cpu";
  }

  return "cpu";
}

// =====================================================
// CUDA Availability Verification
// =====================================================

/**
 * Verify that CUDA provider (libonnxruntime_providers_cuda.so) is available.
 *
 * onnxruntime-node can download the CUDA provider shared library via
 * `ONNXRUNTIME_NODE_INSTALL_CUDA=v12 node .../install.js`. This function
 * checks for its presence on disk rather than trying to resolve a
 * non-existent npm package (onnxruntime-gpu is Python-only).
 *
 * @param logPrefix - Log prefix for warning messages
 */
export function verifyCudaAvailability(logPrefix?: string): boolean {
  const prefix = logPrefix ?? "OnnxProvider";
  try {
    const esmRequire = createRequire(import.meta.url);
    const ortNodePath = esmRequire.resolve("onnxruntime-node");
    // require.resolve returns e.g. .../onnxruntime-node/dist/index.js
    // Walk up to package root by finding the directory containing package.json
    let packageDir = nodePath.dirname(ortNodePath);
    for (let i = 0; i < 5; i++) {
      if (fs.existsSync(nodePath.join(packageDir, "package.json"))) break;
      packageDir = nodePath.dirname(packageDir);
    }

    // Search across napi versions (v3, v6, etc.) for CUDA provider
    const binDir = nodePath.join(packageDir, "bin");
    if (fs.existsSync(binDir)) {
      const napiDirs = fs.readdirSync(binDir).filter((d) => d.startsWith("napi-v"));
      for (const napiDir of napiDirs) {
        const cudaProviderPath = nodePath.join(
          binDir,
          napiDir,
          "linux",
          "x64",
          "libonnxruntime_providers_cuda.so"
        );
        if (fs.existsSync(cudaProviderPath)) {
          return true;
        }
      }
    }

    console.warn("[%s] CUDA provider not found in: %s", prefix, binDir);
    return false;
  } catch {
    console.warn("[%s] Cannot verify CUDA provider: onnxruntime-node not found", prefix);
    return false;
  }
}

// =====================================================
// LD_LIBRARY_PATH Check
// =====================================================

/**
 * Verify that LD_LIBRARY_PATH is set at the OS level (not just process.env).
 *
 * dlopen() reads LD_LIBRARY_PATH from the kernel environment (/proc/self/environ),
 * NOT from process.env modifications made at runtime. If LD_LIBRARY_PATH was set
 * after process startup (e.g. by loadEnvLocal()), dlopen() cannot find CUDA
 * libraries and ONNX Runtime CUDA provider initialization will segfault or throw.
 *
 * Returns true only if LD_LIBRARY_PATH was present in the original process environment.
 *
 * @returns true if LD_LIBRARY_PATH is set at OS level, or if /proc/self/environ is unavailable
 */
export function isLdLibraryPathSetAtOsLevel(): boolean {
  try {
    const procEnv = fs.readFileSync("/proc/self/environ", "utf-8");
    return procEnv.includes("LD_LIBRARY_PATH");
  } catch {
    // /proc/self/environ not available (non-Linux) — assume set
    return true;
  }
}
