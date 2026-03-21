#!/usr/bin/env tsx
// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DINOv2 ONNX Model Download Script
 *
 * Security features [H-2]:
 * - SHA-256 hash verification after download
 * - Download source whitelist (huggingface.co only)
 * - File size cap (500MB)
 * - Path traversal defense for DINOV2_MODEL_PATH
 *
 * Usage:
 *   pnpm dlx tsx packages/ml/scripts/download-dinov2.ts
 *   pnpm dlx tsx packages/ml/scripts/download-dinov2.ts --clean
 *   DINOV2_MODEL_PATH=/custom/path pnpm dlx tsx packages/ml/scripts/download-dinov2.ts
 */

import { createHash } from "crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync } from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** HuggingFace Hub URL for DINOv2 ViT-B/14 ONNX model (FP32) */
const MODEL_URL = "https://huggingface.co/Xenova/dinov2-base/resolve/main/onnx/model.onnx";

/**
 * Expected SHA-256 hash of the model file.
 * Compute after first verified download:
 *   sha256sum packages/ml/models/dinov2-base/model.onnx
 * Then replace this placeholder.
 */
const EXPECTED_SHA256 = "de9c675d214f0171285f90f1d1d7716bce1c5e280e93826d071d57f7b9314d98";

/** Maximum allowed model file size in bytes (500 MB) */
const MAX_MODEL_SIZE_BYTES = 500 * 1024 * 1024;

/** Allowed download hostnames */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["huggingface.co"]);

/** Default output path (relative to this script's package, i.e. packages/ml/) */
const DEFAULT_MODEL_DIR = "models/dinov2-base";
const MODEL_FILENAME = "model.onnx";

// ---------------------------------------------------------------------------
// Utilities (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Validate that a URL uses HTTPS and its hostname is in the allowlist.
 * @throws {Error} if the URL is not allowed
 */
export function validateDownloadUrl(urlString: string): URL {
  const parsed = new URL(urlString);

  if (parsed.protocol !== "https:") {
    throw new Error(`Download URL must use HTTPS. Got: ${parsed.protocol}`);
  }

  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `Download host not in allowlist. Got: ${parsed.hostname}, allowed: ${[...ALLOWED_HOSTS].join(", ")}`
    );
  }

  return parsed;
}

/**
 * Validate model output path against path traversal attacks.
 *
 * Rules:
 * - Resolved path must not contain literal `..` segments
 * - Paths outside the project root emit a warning (but are allowed for
 *   explicit override via DINOV2_MODEL_PATH)
 *
 * @returns The fully resolved absolute path
 * @throws {Error} on path traversal detection
 */
export function validateModelPath(modelPath: string): string {
  const resolved = path.resolve(modelPath);

  // After resolving, the path should not contain `..`
  // (path.resolve normalises, but we double-check the raw input)
  const normalised = path.normalize(modelPath);
  if (normalised.includes("..")) {
    throw new Error(`Path traversal detected in model path: ${modelPath}`);
  }

  // Warn if outside project directory (but allow it for explicit overrides)
  const projectRoot = path.resolve(process.cwd());
  if (!resolved.startsWith(projectRoot) && !resolved.startsWith("/tmp/")) {
    console.warn(`Warning: Model path outside project directory: ${resolved}`);
  }

  return resolved;
}

/**
 * Compute SHA-256 hash of a file using streaming reads.
 */
export async function computeFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Validate file size against the cap.
 * @throws {Error} if the file exceeds MAX_MODEL_SIZE_BYTES
 */
export function validateFileSize(filePath: string): void {
  const stats = statSync(filePath);
  if (stats.size > MAX_MODEL_SIZE_BYTES) {
    throw new Error(
      `Model file exceeds size cap: ${stats.size} bytes > ${MAX_MODEL_SIZE_BYTES} bytes (500 MB)`
    );
  }
}

// ---------------------------------------------------------------------------
// Download logic
// ---------------------------------------------------------------------------

/**
 * Download the DINOv2 ONNX model with streaming progress, hash verification,
 * and size cap enforcement.
 */
async function downloadModel(outputPath: string): Promise<void> {
  const resolvedOutput = validateModelPath(outputPath);
  const outputDir = path.dirname(resolvedOutput);

  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
    console.log(`Created directory: ${outputDir}`);
  }

  // Check if model already exists
  if (existsSync(resolvedOutput)) {
    console.log(`Model already exists at: ${resolvedOutput}`);
    console.log("Verifying existing model...");

    validateFileSize(resolvedOutput);
    const existingHash = await computeFileHash(resolvedOutput);

    if (EXPECTED_SHA256 !== "TODO_COMPUTE_ON_FIRST_DOWNLOAD") {
      if (existingHash === EXPECTED_SHA256) {
        console.log("SHA-256 hash verified. Model is valid.");
        return;
      }
      console.warn(
        `Hash mismatch for existing model. Expected: ${EXPECTED_SHA256}, Got: ${existingHash}`
      );
      console.log("Re-downloading model...");
    } else {
      console.log(`Existing model SHA-256: ${existingHash}`);
      console.log("EXPECTED_SHA256 is a placeholder. Please update it in the script.");
      return;
    }
  }

  // Validate download URL
  const url = validateDownloadUrl(MODEL_URL);
  console.log(`Downloading DINOv2 model from: ${url.href}`);

  // Download to temporary file first
  const tmpPath = `${resolvedOutput}.tmp`;

  const response = await fetch(url.href, {
    headers: {
      "User-Agent": "Reftrix-ML/0.1.0 (model-download)",
    },
  });

  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }

  // Check Content-Length before downloading
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const expectedSize = parseInt(contentLength, 10);
    if (expectedSize > MAX_MODEL_SIZE_BYTES) {
      throw new Error(
        `Content-Length exceeds size cap: ${expectedSize} bytes > ${MAX_MODEL_SIZE_BYTES} bytes (500 MB)`
      );
    }
    console.log(`Expected size: ${(expectedSize / 1024 / 1024).toFixed(1)} MB`);
  }

  // Stream download with progress
  if (!response.body) {
    throw new Error("Response body is null");
  }

  const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
  let downloadedBytes = 0;
  let lastProgressPct = -1;

  const progressTransform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller): void {
      downloadedBytes += chunk.length;

      // Enforce size cap during download
      if (downloadedBytes > MAX_MODEL_SIZE_BYTES) {
        controller.error(
          new Error(
            `Download exceeds size cap at ${downloadedBytes} bytes (limit: ${MAX_MODEL_SIZE_BYTES})`
          )
        );
        return;
      }

      if (totalBytes > 0) {
        const pct = Math.floor((downloadedBytes / totalBytes) * 100);
        if (pct !== lastProgressPct && pct % 10 === 0) {
          lastProgressPct = pct;
          const mb = (downloadedBytes / 1024 / 1024).toFixed(1);
          process.stdout.write(`\r  Progress: ${pct}% (${mb} MB)`);
        }
      }

      controller.enqueue(chunk);
    },
  });

  const webStream = response.body.pipeThrough(progressTransform);
  const nodeStream = Readable.fromWeb(webStream as Parameters<typeof Readable.fromWeb>[0]);
  const writeStream = createWriteStream(tmpPath);

  await pipeline(nodeStream, writeStream);
  console.log(""); // Newline after progress

  // Validate file size
  validateFileSize(tmpPath);
  console.log(`Downloaded: ${(downloadedBytes / 1024 / 1024).toFixed(1)} MB`);

  // Compute and verify SHA-256 hash
  const hash = await computeFileHash(tmpPath);
  console.log(`SHA-256: ${hash}`);

  if (EXPECTED_SHA256 === "TODO_COMPUTE_ON_FIRST_DOWNLOAD") {
    console.log("");
    console.log("This is the first download. Please update EXPECTED_SHA256 in the script:");
    console.log(`  EXPECTED_SHA256 = '${hash}'`);
    console.log("");
  } else if (hash !== EXPECTED_SHA256) {
    // Hash mismatch - delete the file and error
    rmSync(tmpPath, { force: true });
    throw new Error(
      `SHA-256 hash mismatch!\n  Expected: ${EXPECTED_SHA256}\n  Got:      ${hash}\nDownloaded file has been deleted.`
    );
  } else {
    console.log("SHA-256 hash verified.");
  }

  // Rename temp file to final path (atomic on same filesystem)
  const { renameSync } = await import("fs");
  renameSync(tmpPath, resolvedOutput);
  console.log(`Model saved to: ${resolvedOutput}`);
}

/**
 * Clean (delete) the model file.
 */
async function cleanModel(outputPath: string): Promise<void> {
  const resolvedOutput = validateModelPath(outputPath);

  if (existsSync(resolvedOutput)) {
    rmSync(resolvedOutput);
    console.log(`Deleted: ${resolvedOutput}`);
  } else {
    console.log(`Model file not found: ${resolvedOutput}`);
  }

  // Remove parent directory if empty
  const dir = path.dirname(resolvedOutput);
  if (existsSync(dir)) {
    const { readdirSync } = await import("fs");
    if (readdirSync(dir).length === 0) {
      rmSync(dir, { recursive: true });
      console.log(`Removed empty directory: ${dir}`);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function getModelOutputPath(): string {
  const envPath = process.env["DINOV2_MODEL_PATH"];
  if (envPath) {
    return envPath;
  }
  return path.join(DEFAULT_MODEL_DIR, MODEL_FILENAME);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isClean = args.includes("--clean");
  const outputPath = getModelOutputPath();

  console.log("=== DINOv2 ONNX Model Manager ===");
  console.log(`Output path: ${path.resolve(outputPath)}`);
  console.log("");

  if (isClean) {
    await cleanModel(outputPath);
  } else {
    await downloadModel(outputPath);
  }
}

// Only run CLI when executed directly (not when imported for testing)
const isDirectExecution =
  process.argv[1]?.endsWith("download-dinov2.ts") ||
  process.argv[1]?.endsWith("download-dinov2.js");

if (isDirectExecution) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nError: ${message}`);
    process.exit(1);
  });
}
