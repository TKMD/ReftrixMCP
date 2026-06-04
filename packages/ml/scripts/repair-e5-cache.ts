#!/usr/bin/env tsx
// SPDX-FileCopyrightText: 2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * multilingual-e5-base ONNX Cache Integrity Check + Repair / 整合性チェック + 修復
 *
 * Wave 4 V4 carryover closure (T+1d 2026-05-13 deadline).
 *
 * Purpose / 目的:
 *   transformers.js 3.8.1 cache (`Xenova/multilingual-e5-base/onnx/model.onnx`) の
 *   integrity を SHA-256 で検証し、corruption / partial download 検出時に
 *   HuggingFace Hub から再 download する。並列 vitest worker による
 *   cold-start race condition の修復経路としても機能。
 *
 *   Verifies integrity of transformers.js 3.8.1 cache via SHA-256, and re-downloads
 *   from HuggingFace Hub on corruption / partial download. Also serves as a repair
 *   path for cold-start race conditions across parallel vitest workers.
 *
 * Security features:
 *   - SHA-256 hash verification after download
 *   - Download source whitelist (huggingface.co only)
 *   - File size cap (1.5GB to allow for the 1.1GB model)
 *   - Path traversal defense for cache root
 *   - Atomic rename to avoid partial writes visible to parallel workers
 *
 * Usage / 使い方:
 *   pnpm dlx tsx packages/ml/scripts/repair-e5-cache.ts          # check only
 *   pnpm dlx tsx packages/ml/scripts/repair-e5-cache.ts --check  # check only (explicit)
 *   pnpm dlx tsx packages/ml/scripts/repair-e5-cache.ts --repair # check + repair if corrupted
 *   pnpm dlx tsx packages/ml/scripts/repair-e5-cache.ts --force  # force re-download
 *   pnpm dlx tsx packages/ml/scripts/repair-e5-cache.ts --clean  # delete cache only
 *
 * Exit codes:
 *   0 — cache is healthy (or repair succeeded)
 *   1 — cache is corrupted and --repair was not provided
 *   2 — repair attempted but failed
 *   3 — invalid arguments / configuration
 *
 * Idempotent: safe to re-run.
 * Compatible with AGPL-3.0-only (Reftrix root) and MIT (multilingual-e5-base model).
 */

import { createHash } from "crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline as streamPipeline } from "stream/promises";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** HuggingFace Hub URL for multilingual-e5-base ONNX model (FP32 unquantized). */
const MODEL_URL = "https://huggingface.co/Xenova/multilingual-e5-base/resolve/main/onnx/model.onnx";

/**
 * Expected SHA-256 hash of the model file.
 * Source: HuggingFace `x-linked-etag` header for the canonical model.onnx blob.
 * Confirmed: 2026-05-13 against local cache (matched).
 */
const EXPECTED_SHA256 = "84a4d426f7e87a6bf5bf195f0bae2c4a7d15f675b23ca96f42fab8326d7a77aa";

/** Expected size from HuggingFace `x-linked-size` header. */
const EXPECTED_SIZE_BYTES = 1_110_059_084;

/** Maximum allowed model file size in bytes (1.5GB safety margin around 1.1GB model). */
const MAX_MODEL_SIZE_BYTES = 1_500 * 1024 * 1024;

/** Allowed download hostnames. */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["huggingface.co"]);

/**
 * transformers.js 3.8.1 cache path relative to repo root.
 * `.cache/Xenova/multilingual-e5-base/onnx/model.onnx`
 */
const CACHE_REL =
  "node_modules/.pnpm/@huggingface+transformers@3.8.1/node_modules/@huggingface/transformers/.cache/Xenova/multilingual-e5-base";

const MODEL_FILENAME = "model.onnx";

// ---------------------------------------------------------------------------
// Utilities
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
      `Download host not in allowlist. Got: ${parsed.hostname}, allowed: ${[...ALLOWED_HOSTS].join(
        ", "
      )}`
    );
  }

  return parsed;
}

/**
 * Walk upwards from `startDir` looking for the monorepo root marker
 * (`pnpm-workspace.yaml`). Falls back to `startDir` if not found.
 */
function findRepoRoot(startDir: string): string {
  let current = path.resolve(startDir);
  // Guard against infinite loops on filesystems without `/`.
  for (let i = 0; i < 32; i++) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return startDir;
}

/**
 * Resolve and validate the cache root path against path traversal attacks.
 *
 * Rules:
 *   - Resolved path must not contain literal `..` segments
 *   - Must reside within the repo root tree (auto-detected via pnpm-workspace.yaml)
 *
 * @returns The fully resolved absolute path to the cache directory
 * @throws {Error} on path traversal detection
 */
export function resolveCacheDir(cwd: string = process.cwd()): string {
  if (CACHE_REL.includes("..")) {
    throw new Error(`Path traversal detected in CACHE_REL: ${CACHE_REL}`);
  }

  const repoRoot = findRepoRoot(cwd);
  const resolved = path.resolve(repoRoot, CACHE_REL);

  if (!resolved.startsWith(repoRoot + path.sep) && resolved !== repoRoot) {
    throw new Error(
      `Resolved cache path is outside the repo root. root=${repoRoot}, resolved=${resolved}`
    );
  }

  return resolved;
}

/**
 * Compute SHA-256 of a file, streaming to avoid loading 1.1GB into memory.
 */
export async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await streamPipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

interface IntegrityReport {
  exists: boolean;
  sizeMatches: boolean | null;
  hashMatches: boolean | null;
  actualSize: number | null;
  actualHash: string | null;
  modelPath: string;
}

/**
 * Inspect the ONNX cache file and return an integrity report.
 * Does not throw on missing / corrupted files — the caller decides repair.
 */
export async function inspectCache(cacheDir: string): Promise<IntegrityReport> {
  const modelPath = path.join(cacheDir, "onnx", MODEL_FILENAME);
  const report: IntegrityReport = {
    exists: false,
    sizeMatches: null,
    hashMatches: null,
    actualSize: null,
    actualHash: null,
    modelPath,
  };

  if (!existsSync(modelPath)) {
    return report;
  }
  report.exists = true;

  const stats = statSync(modelPath);
  report.actualSize = stats.size;
  report.sizeMatches = stats.size === EXPECTED_SIZE_BYTES;

  // Size mismatch is sufficient to declare corruption — skip expensive hash compute.
  if (!report.sizeMatches) {
    return report;
  }

  // Size matches — verify hash for full integrity.
  report.actualHash = await sha256OfFile(modelPath);
  report.hashMatches = report.actualHash === EXPECTED_SHA256;
  return report;
}

/**
 * Download the model to a temp file, then atomically rename into place.
 * This avoids parallel workers seeing partial files (the root cause of
 * "Protobuf parsing failed" cold-start races).
 */
async function downloadModel(targetPath: string): Promise<void> {
  validateDownloadUrl(MODEL_URL);

  const targetDir = path.dirname(targetPath);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const tempPath = `${targetPath}.partial.${process.pid}`;

  // eslint-disable-next-line no-console
  console.log(`[repair-e5-cache] Downloading ${MODEL_URL}`);
  // eslint-disable-next-line no-console
  console.log(`[repair-e5-cache] → ${tempPath}`);

  // `redirect: "follow"` is intentional and safe here per FIND-WAVE4-V4-FINAL-SEC-L-02
  // (Wave 4 V4 defense-in-depth note):
  //   (1) MODEL_URL is hard-pinned to `https://huggingface.co/...` and validated via
  //       `validateDownloadUrl()` above (HTTPS-only + `ALLOWED_HOSTS` whitelist).
  //   (2) HuggingFace returns 302 to its own CDN domain which remains within the
  //       allowlist semantic; we do NOT validate the post-redirect host explicitly,
  //       but...
  //   (3) ...the SHA-256 pin (`EXPECTED_SHA256`) enforced after stream completion
  //       structurally rejects any redirect-substituted payload regardless of the
  //       final hop. This reduces the redirect path to a content-integrity check:
  //         - CWE-918 (SSRF) is mitigated by the host allowlist up-front; AND
  //         - CWE-494 (Untrusted Code Download) is mitigated by the SHA-256 pin
  //           verified before atomic-rename publishes the file.
  // If a future change broadens `ALLOWED_HOSTS`, revisit this redirect policy.
  const response = await fetch(MODEL_URL, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error("Download failed: response body is null");
  }

  // Pre-check content-length against MAX_MODEL_SIZE_BYTES.
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const sizeBytes = Number(contentLength);
    if (Number.isFinite(sizeBytes) && sizeBytes > MAX_MODEL_SIZE_BYTES) {
      throw new Error(
        `Download rejected: content-length ${sizeBytes} exceeds cap ${MAX_MODEL_SIZE_BYTES}`
      );
    }
  }

  const fileStream = createWriteStream(tempPath);
  try {
    // Node's fetch returns a Web ReadableStream; bridge to Node stream.
    await streamPipeline(
      Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      fileStream
    );
  } catch (err) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      /* swallow cleanup errors */
    }
    throw err;
  }

  // Post-check size + hash before publishing.
  const stats = statSync(tempPath);
  if (stats.size !== EXPECTED_SIZE_BYTES) {
    rmSync(tempPath, { force: true });
    throw new Error(`Downloaded size mismatch: got ${stats.size}, expected ${EXPECTED_SIZE_BYTES}`);
  }
  if (stats.size > MAX_MODEL_SIZE_BYTES) {
    rmSync(tempPath, { force: true });
    throw new Error(`Downloaded size ${stats.size} exceeds cap ${MAX_MODEL_SIZE_BYTES}`);
  }

  const actualHash = await sha256OfFile(tempPath);
  if (actualHash !== EXPECTED_SHA256) {
    rmSync(tempPath, { force: true });
    throw new Error(`SHA-256 mismatch: got ${actualHash}, expected ${EXPECTED_SHA256}`);
  }

  // Atomic publish.
  renameSync(tempPath, targetPath);
  // eslint-disable-next-line no-console
  console.log(`[repair-e5-cache] ✓ Atomic rename complete: ${targetPath}`);
}

/**
 * Delete the entire ONNX cache directory (model.onnx + onnx/ subdir).
 * Used by --clean and --repair to ensure a fresh state.
 */
function cleanCacheModel(cacheDir: string): void {
  const onnxDir = path.join(cacheDir, "onnx");
  if (existsSync(onnxDir)) {
    rmSync(onnxDir, { recursive: true, force: true });
    // eslint-disable-next-line no-console
    console.log(`[repair-e5-cache] Removed ${onnxDir}`);
  }
}

// ---------------------------------------------------------------------------
// CLI Entrypoint
// ---------------------------------------------------------------------------

interface CliFlags {
  check: boolean;
  repair: boolean;
  force: boolean;
  clean: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {
    check: false,
    repair: false,
    force: false,
    clean: false,
  };
  for (const a of argv.slice(2)) {
    if (a === "--check") flags.check = true;
    else if (a === "--repair") flags.repair = true;
    else if (a === "--force") flags.force = true;
    else if (a === "--clean") flags.clean = true;
    else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`[repair-e5-cache] Unknown flag: ${a}`);
      printUsage();
      process.exit(3);
    }
  }
  // Default to check-only when no flag is provided.
  if (!flags.check && !flags.repair && !flags.force && !flags.clean) {
    flags.check = true;
  }
  return flags;
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(`
Usage: repair-e5-cache.ts [--check | --repair | --force | --clean]

  --check    Verify integrity of model.onnx (default if no flag given)
  --repair   Verify + re-download on mismatch (idempotent)
  --force    Always re-download, even when cache is healthy
  --clean    Delete the onnx/ cache subdirectory and exit
  -h, --help Show this help message

Exit codes:
  0  cache healthy (or repair succeeded)
  1  cache corrupted and --repair not provided
  2  repair attempted but failed
  3  invalid arguments
`);
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv);
  const cacheDir = resolveCacheDir();

  // eslint-disable-next-line no-console
  console.log(`[repair-e5-cache] Cache dir: ${cacheDir}`);

  if (flags.clean) {
    cleanCacheModel(cacheDir);
    return 0;
  }

  if (flags.force) {
    cleanCacheModel(cacheDir);
    const target = path.join(cacheDir, "onnx", MODEL_FILENAME);
    await downloadModel(target);
    return 0;
  }

  const report = await inspectCache(cacheDir);

  if (!report.exists) {
    // eslint-disable-next-line no-console
    console.log(`[repair-e5-cache] ✗ Missing: ${report.modelPath}`);
    if (!flags.repair) {
      // eslint-disable-next-line no-console
      console.log(`[repair-e5-cache] Re-run with --repair to download.`);
      return 1;
    }
    await downloadModel(report.modelPath);
    return 0;
  }

  if (report.sizeMatches === false) {
    // eslint-disable-next-line no-console
    console.log(
      `[repair-e5-cache] ✗ Size mismatch: got ${report.actualSize}, expected ${EXPECTED_SIZE_BYTES}`
    );
    if (!flags.repair) return 1;
    cleanCacheModel(cacheDir);
    await downloadModel(report.modelPath);
    return 0;
  }

  if (report.hashMatches === false) {
    // eslint-disable-next-line no-console
    console.log(
      `[repair-e5-cache] ✗ SHA-256 mismatch: got ${report.actualHash}, expected ${EXPECTED_SHA256}`
    );
    if (!flags.repair) return 1;
    cleanCacheModel(cacheDir);
    await downloadModel(report.modelPath);
    return 0;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[repair-e5-cache] ✓ Cache is healthy (size=${report.actualSize}, sha256=${report.actualHash})`
  );
  return 0;
}

// Only run when executed directly (not when imported by tests).
const isDirectExec =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("repair-e5-cache.ts");

if (isDirectExec) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[repair-e5-cache] FATAL: ${(err as Error).message}`);
      process.exit(2);
    });
}
