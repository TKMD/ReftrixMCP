#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Manual Embedding Backfill CLI
 *
 * Finds pages with missing embeddings and generates them.
 * Uses the same logic as the pipeline's post-embedding backfill
 * and the worker startup backfill.
 *
 * **Memory isolation**: When processing all pages (no --url filter),
 * the script spawns a separate child process per site.  Each child
 * loads its own ONNX Runtime, processes one site, then exits —
 * releasing all GPU/CPU memory back to the OS.  This prevents RSS
 * accumulation that occurs when the ONNX Worker Thread processes
 * hundreds of embeddings in a single long-lived process.
 *
 * Usage:
 *   pnpm backfill:embeddings                           # All pages (1 process per site)
 *   pnpm backfill:embeddings -- --dry-run               # Count only, no changes
 *   pnpm backfill:embeddings -- --limit 50              # Process max 50 per page
 *   pnpm backfill:embeddings -- --url stripe.com        # Specific URL (in-process)
 *   pnpm backfill:embeddings -- --chunk-size 10         # Custom chunk size
 *
 * @module scripts/backfill-embeddings
 */

import { prisma } from '@reftrix/database';
import { embeddingService } from '@reftrix/ml';
import {
  backfillWebPageEmbeddings,
  checkWebPageEmbeddingCoverage,
  findWebPagesWithMissingEmbeddings,
} from '../services/embedding-backfill.service';
import {
  setEmbeddingServiceFactory,
  setPrismaClientFactory as setLayoutPrismaClientFactory,
  LayoutEmbeddingService,
} from '../services/layout-embedding.service';
import {
  setPrismaClientFactory as setMotionPrismaClientFactory,
} from '../services/motion/frame-embedding.service';
import {
  setBackgroundEmbeddingServiceFactory,
  setBackgroundPrismaClientFactory,
  setMotionLayoutEmbeddingServiceFactory,
} from '../tools/page/handlers/embedding-handler';

/* eslint-disable no-console */

// Load .env.local if present
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Sentinel env var to prevent infinite re-exec loops.
 * Set by ensureLdLibraryPathForCuda() before re-spawning.
 */
const REEXEC_SENTINEL = '__REFTRIX_CUDA_REEXEC';

/**
 * Parse .env.local into a key-value map (without modifying process.env).
 */
function parseEnvLocal(): Record<string, string> {
  const envPaths = [
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(__dirname, '../../../../.env.local'),
  ];

  const envVars: Record<string, string> = {};

  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const [key, ...valueParts] = trimmed.split('=');
        if (key) {
          envVars[key] = valueParts.join('=').replace(/^["']|["']$/g, '');
        }
      }
      break;
    }
  }

  return envVars;
}

function loadEnvLocal(): void {
  const envVars = parseEnvLocal();
  for (const [key, value] of Object.entries(envVars)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

/**
 * Ensure LD_LIBRARY_PATH is set at the OS level for CUDA to work.
 *
 * When ONNX_EXECUTION_PROVIDER=cuda is configured (in .env.local or env),
 * LD_LIBRARY_PATH must be set BEFORE the Node.js process starts so that
 * the dynamic linker (ld.so) can find CUDA shared libraries when dlopen()
 * is called by onnxruntime-node.
 *
 * Setting process.env.LD_LIBRARY_PATH at runtime does NOT work because
 * dlopen() reads from the kernel environment (/proc/self/environ), not
 * from Node.js's process.env object.
 *
 * This function detects the mismatch and re-executes the current script
 * with proper LD_LIBRARY_PATH inherited at the OS level.
 *
 * @returns true if execution should continue, false if process will be replaced
 */
function ensureLdLibraryPathForCuda(): boolean {
  // Already re-executed — don't loop
  if (process.env[REEXEC_SENTINEL] === '1') return true;

  // Read .env.local to check if CUDA is requested
  const envVars = parseEnvLocal();
  const onnxProvider = process.env.ONNX_EXECUTION_PROVIDER ?? envVars['ONNX_EXECUTION_PROVIDER'];
  if (onnxProvider !== 'cuda' && onnxProvider !== 'rocm') return true;

  // Check if LD_LIBRARY_PATH is already set at the OS level
  try {
    const procEnv = fs.readFileSync('/proc/self/environ', 'utf-8');
    if (procEnv.includes('LD_LIBRARY_PATH')) return true;
  } catch {
    // Non-Linux or /proc not available — assume OK
    return true;
  }

  // LD_LIBRARY_PATH is needed but not set at the OS level.
  // Re-exec the current process with proper environment.
  const ldPath = process.env.LD_LIBRARY_PATH ?? envVars['LD_LIBRARY_PATH'];
  if (!ldPath) {
    console.warn('[Backfill] CUDA requested but LD_LIBRARY_PATH not configured. Falling back to CPU.');
    return true;
  }

  console.warn('[Backfill] Re-executing with LD_LIBRARY_PATH for CUDA support...');

  // Build merged environment: current env + .env.local vars + sentinel
  const mergedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) mergedEnv[k] = v;
  }
  for (const [k, v] of Object.entries(envVars)) {
    if (!(k in mergedEnv)) mergedEnv[k] = v;
  }
  mergedEnv[REEXEC_SENTINEL] = '1';
  // Ensure LD_LIBRARY_PATH is in the OS-level environment
  mergedEnv['LD_LIBRARY_PATH'] = ldPath;

  try {
    // Re-exec with the same argv and execArgv (--expose-gc etc.),
    // inheriting stdio for seamless output.
    // execFileSync blocks until child exits, effectively replacing this process.
    //
    // SEC-H3: execFileSync（execSyncではない）を使用。
    // - execFileSyncはシェル展開なし（コマンドインジェクション不可）
    // - process.execPath はNode.jsバイナリパス（ユーザー入力なし）
    // - stdio: 'inherit' は親プロセスのstdio fdを共有（PID等の露出リスクなし）
    const childArgs = [...process.execArgv, ...process.argv.slice(1)];
    execFileSync(process.execPath, childArgs, {
      env: mergedEnv,
      stdio: 'inherit',
    });
    // execFileSync returns buffer on success (exit code 0)
    process.exit(0);
  } catch (error) {
    // execFileSync throws if child exits with non-zero code
    const exitCode = (error as { status?: number }).status ?? 1;
    process.exit(exitCode);
  }

  // Unreachable, but TypeScript needs it
  return false;
}

/**
 * Sentinel env var set by the orchestrator process when spawning per-site
 * child processes.  Prevents the child from re-entering the orchestrator path.
 */
const PER_SITE_CHILD_SENTINEL = '__REFTRIX_BACKFILL_CHILD';

interface CliOptions {
  dryRun: boolean;
  limit: number | undefined;
  urlFilter: string | undefined;
  chunkSize: number;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limit = args.includes('--limit')
    ? parseInt(args[args.indexOf('--limit') + 1] || '0', 10) || undefined
    : undefined;
  const urlFilter = args.includes('--url')
    ? args[args.indexOf('--url') + 1]
    : undefined;
  const chunkSize = args.includes('--chunk-size')
    ? parseInt(args[args.indexOf('--chunk-size') + 1] || '15', 10)
    : 15;

  return { dryRun, limit, urlFilter, chunkSize };
}

async function main(): Promise<void> {
  // CUDA requires LD_LIBRARY_PATH at the OS level (before dlopen).
  // If it's only in .env.local, re-exec the process with proper env.
  if (!ensureLdLibraryPathForCuda()) return;

  loadEnvLocal();

  // Initialize DI factories — same pattern as page-analyze-worker.ts (lines 108-115)
  // 1. EmbeddingService factory: LayoutEmbeddingService uses this to get ONNX inference
  setEmbeddingServiceFactory(() => embeddingService);
  // 2. PrismaClient factories: used by saveSectionEmbedding / saveMotionEmbedding
  setLayoutPrismaClientFactory(() => prisma as never);
  setMotionPrismaClientFactory(() => prisma as never);
  setBackgroundPrismaClientFactory(() => prisma as never);
  // 3. Shared LayoutEmbeddingService for Background/Motion embedding handlers
  const sharedLayoutEmbeddingService = new LayoutEmbeddingService();
  setBackgroundEmbeddingServiceFactory(() => sharedLayoutEmbeddingService);
  setMotionLayoutEmbeddingServiceFactory(() => sharedLayoutEmbeddingService);

  const options = parseArgs();

  const totalMemGB = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
  const thresholdGB = (os.totalmem() * 0.70 / 1024 / 1024 / 1024).toFixed(1);

  console.log('=== Embedding Backfill ===');
  console.log(`Mode: ${options.dryRun ? 'DRY RUN (no changes)' : 'LIVE'}`);
  console.log(`Memory: ${totalMemGB}GB total, threshold ${thresholdGB}GB (70%)`);
  if (options.limit) console.log(`Limit: ${options.limit} per page`);
  if (options.urlFilter) console.log(`URL filter: ${options.urlFilter}`);
  console.log(`Chunk size: ${options.chunkSize}`);
  console.log('');

  // Find pages with missing embeddings
  let pages: { webPageId: string; url: string; missingCount: number }[];

  if (options.urlFilter) {
    const webPage = await prisma.webPage.findFirst({
      where: { url: { contains: options.urlFilter } },
      select: { id: true, url: true },
    });

    if (!webPage) {
      console.log(`No web page found matching: ${options.urlFilter}`);
      process.exit(1);
    }

    const coverage = await checkWebPageEmbeddingCoverage(webPage.id);
    const missingCount = coverage.reduce((sum, c) => sum + c.missing, 0);

    if (missingCount === 0) {
      console.log(`No missing embeddings for ${webPage.url}`);
      await prisma.$disconnect();
      return;
    }

    pages = [{ webPageId: webPage.id, url: webPage.url, missingCount }];
  } else {
    pages = await findWebPagesWithMissingEmbeddings();
  }

  if (pages.length === 0) {
    console.log('No pages with missing embeddings found!');
    await prisma.$disconnect();
    return;
  }

  const grandTotalMissing = pages.reduce((sum, p) => sum + p.missingCount, 0);
  console.log(`Found ${pages.length} pages with ${grandTotalMissing} missing embeddings\n`);

  if (options.dryRun) {
    for (const { url, missingCount, webPageId } of pages) {
      console.log(`  ${url}: ${missingCount} missing`);
      const coverage = await checkWebPageEmbeddingCoverage(webPageId);
      for (const c of coverage) {
        if (c.missing > 0) {
          console.log(`    ${c.type}: ${c.missing}/${c.total} missing`);
        }
      }
    }
    console.log('\n[DRY RUN] No changes made');
    await prisma.$disconnect();
    return;
  }

  // When --url is specified (single site) OR we are a per-site child process,
  // process in-process directly.  Otherwise, orchestrate via child processes.
  const isSingleSite = !!options.urlFilter || process.env[PER_SITE_CHILD_SENTINEL] === '1';

  if (isSingleSite) {
    await backfillSingleProcess(pages, options);
  } else {
    await backfillViaChildProcesses(pages, options);
  }
}

/**
 * Process pages in the current process (used for single-site --url mode
 * and when invoked as a per-site child process).
 */
async function backfillSingleProcess(
  pages: { webPageId: string; url: string; missingCount: number }[],
  options: CliOptions,
): Promise<void> {
  let grandTotalBackfilled = 0;
  let grandTotalErrors = 0;

  for (const { webPageId, url, missingCount } of pages) {
    console.log(`\n--- Backfilling ${url} (${missingCount} missing) ---`);

    const startTime = Date.now();
    const result = await backfillWebPageEmbeddings(webPageId, {
      chunkSize: options.chunkSize,
      onProgress: (type, done, total) => {
        process.stdout.write(
          `\r  ${type}: ${done}/${total}`
        );
      },
      onMemoryPressure: (type, rssGB, thresholdGB2, action) => {
        if (action === 'dispose') {
          console.warn(`\n  MEMORY PRESSURE at ${type}: RSS ${rssGB}GB > ${thresholdGB2}GB — disposing pipeline...`);
        } else {
          console.warn(`\n  MEMORY SKIP at ${type}: RSS ${rssGB}GB > ${thresholdGB2}GB — recovery failed, skipping`);
        }
      },
    });
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    console.log(''); // newline after progress
    console.log(`  Completed in ${elapsed}s`);
    console.log(`  Section: ${result.sectionBackfilled}`);
    console.log(`  Motion: ${result.motionBackfilled}`);
    console.log(`  Background: ${result.backgroundBackfilled}`);
    console.log(`  JS Animation: ${result.jsAnimationBackfilled}`);
    console.log(`  Total: ${result.totalBackfilled}`);

    if (result.memorySkips > 0) {
      console.log(`  Memory skips: ${result.memorySkips}`);
    }
    if (result.errors.length > 0) {
      console.log(`  Errors: ${result.errors.length}`);
      for (const err of result.errors.slice(0, 5)) {
        console.log(`    - ${err}`);
      }
      if (result.errors.length > 5) {
        console.log(`    ... and ${result.errors.length - 5} more`);
      }
    }

    grandTotalBackfilled += result.totalBackfilled;
    grandTotalErrors += result.errors.length;
  }

  console.log('\n=== Summary ===');
  console.log(`Total backfilled: ${grandTotalBackfilled}`);
  console.log(`Total errors: ${grandTotalErrors}`);
  console.log(`Pages processed: ${pages.length}`);

  await prisma.$disconnect();

  // Explicit exit: Worker Thread (ONNX CUDA) keeps the event loop alive.
  // Without this, the process hangs after completion.
  process.exit(0);
}

/**
 * Orchestrate backfill by spawning a separate child process per site.
 *
 * Each child process loads its own ONNX Runtime Worker Thread, processes
 * a single site, then exits — releasing all GPU/CPU memory back to the OS.
 * This prevents RSS accumulation across many sites.
 */
async function backfillViaChildProcesses(
  pages: { webPageId: string; url: string; missingCount: number }[],
  options: CliOptions,
): Promise<void> {
  console.log(`\nProcessing ${pages.length} sites via per-site child processes (memory isolation)\n`);

  await prisma.$disconnect();

  let completed = 0;
  let failed = 0;
  const failedUrls: string[] = [];

  for (const { url, missingCount } of pages) {
    completed++;
    console.log(`[${completed}/${pages.length}] Backfilling: ${url} (${missingCount} missing)`);

    // Build child args: re-invoke this script with --url for the specific site
    const childArgs: string[] = [
      ...process.execArgv,
      ...process.argv.slice(1),
      '--url', url,
    ];

    // Merge current env + sentinel to prevent re-entering orchestrator
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) childEnv[k] = v;
    }
    childEnv[PER_SITE_CHILD_SENTINEL] = '1';

    // Pass chunk-size if not already in argv
    if (!process.argv.includes('--chunk-size')) {
      childArgs.push('--chunk-size', String(options.chunkSize));
    }

    const startTime = Date.now();
    try {
      // SEC-H3: execFileSync使用（シェル展開なし、コマンドインジェクション不可）
      execFileSync(process.execPath, childArgs, {
        env: childEnv,
        stdio: 'inherit',
        timeout: 600_000, // 10 minutes per site
      });
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`  [OK] ${url} done (${elapsed}s)\n`);
    } catch (error) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const exitCode = (error as { status?: number }).status ?? 1;
      console.error(`  [FAIL] ${url} (exit ${exitCode}, ${elapsed}s)\n`);
      failed++;
      failedUrls.push(url);
    }
  }

  console.log('=== Batch Summary ===');
  console.log(`Total sites: ${pages.length}`);
  console.log(`Completed: ${pages.length - failed}`);
  console.log(`Failed: ${failed}`);
  if (failedUrls.length > 0) {
    console.log('Failed URLs:');
    for (const u of failedUrls) {
      console.log(`  - ${u}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
