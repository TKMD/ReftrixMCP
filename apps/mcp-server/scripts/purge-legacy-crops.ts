// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Legacy crop bulk-deletion operator script.
 * legacy crop 一括削除 operator script。
 *
 * Crop generation has ended and no code reads crops any more, so the crop files
 * under `<screenshot root>/crops/<webPageId>/` and the `crop_storage_path` values
 * that point at them are leftovers. This script removes both (GDPR Art.5(1)(e)).
 *
 * Usage:
 *   pnpm tsx apps/mcp-server/scripts/purge-legacy-crops.ts            # dry-run (default)
 *   pnpm tsx apps/mcp-server/scripts/purge-legacy-crops.ts --confirm  # delete
 *   pnpm tsx apps/mcp-server/scripts/purge-legacy-crops.ts --web-page-id=<uuid>
 *
 * Behaviour:
 *   - Dry-run is the default: nothing is written to the file system, the database
 *     or audit_logs. `--confirm` is required to delete.
 *   - The file side drives the run (a directory with no database row is deleted
 *     too). Only directories whose name is a UUID are removed, and only through
 *     `buildSafeCropDir`. If the crops directory itself is a symlink the run is
 *     aborted. Symlinks and non-UUID entries are never touched: they are counted
 *     as `skippedUnsafe` and make the run exit non-zero.
 *   - Before anything is deleted the stored `crop_storage_path` values are compared
 *     (string comparison only) with the resolved crops directory. If even one row
 *     points elsewhere (the script runs with a different screenshot root than the
 *     one that wrote the files) nothing is deleted, no audit row is written and the run
 *     exits 1 (a dry-run reports the count).
 *   - Order: files, then `crop_storage_path` set to NULL (pages whose directory
 *     could not be removed, or was left in place as a symlink / non-directory, keep
 *     their stored path), then one audit row. Once anything has been deleted the
 *     audit row is written even if a later step throws (`result: "failure"`).
 *   - The crops directory is re-checked before every removal; if it has been
 *     replaced by a symlink the run stops.
 *   - Idempotent: a second run finds nothing, writes no audit row and exits 0.
 *
 * Run it against a real database only after `pnpm db:backup`.
 *
 * @module scripts/purge-legacy-crops
 */

import "@reftrixmcp/core/assert-node-runtime";
import fs from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { loadEnvLocal } from "@reftrixmcp/core";
import { sanitizeErrorMessage } from "../src/utils/sanitize-error";
import {
  bootstrapAuditLogServiceForScript,
  getAuditLogService,
  truncateAuditTargetId,
} from "../src/services/audit-log.service";
import { UUID_REGEX } from "../src/services/screenshot-persistence.service";
import { buildSafeCropDir, resolveCropRoot } from "../src/services/part/crop-persistence.helper";
import {
  AUDIT_ACTION_CROP_LEGACY_BULK_DELETED,
  AUDIT_ACTOR_CROP_LEGACY_PURGE,
} from "../src/audit/audit-actions";

// =====================================================
// CLI args
// =====================================================

export interface CliArgs {
  dryRun: boolean;
  confirm: boolean;
  webPageId?: string;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  const confirm = args.includes("--confirm");
  const webPageArg = args.find((a) => a.startsWith("--web-page-id="));
  const webPageId = webPageArg ? webPageArg.slice("--web-page-id=".length) : undefined;
  if (webPageId !== undefined && !UUID_REGEX.test(webPageId)) {
    throw new Error("[purge-legacy-crops] --web-page-id must be a valid UUID v4/v7");
  }
  const result: CliArgs = { dryRun: !confirm, confirm };
  if (webPageId) result.webPageId = webPageId;
  return result;
}

// =====================================================
// Types
// =====================================================

/** Minimal Prisma surface (tagged-template raw queries) for DI in tests. */
export interface PurgePrismaClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export interface PurgeResult {
  /** crop directories deleted (dry-run: that would be deleted) */
  dirsDeleted: number;
  /** of those, directories whose web_pages row does not exist */
  orphanDirs: number;
  bytesFreed: number;
  sectionRowsCleared: number;
  partRowsCleared: number;
  /** symlinks / non-UUID entries left untouched */
  skippedUnsafe: number;
  /** directories that could not be removed */
  failed: number;
  /** rows whose stored path is outside the resolved crops directory */
  rootMismatchRows: number;
}

/** Deterministic abort (printed verbatim: it carries no internal structure). */
export class PurgeAbortError extends Error {}

const ID_CHUNK_SIZE = 500;

const logger = {
  warn: (msg: string): void => {
    console.warn(msg);
  },
};

/** CWE-117: render an untrusted file name as a quoted, escaped, length-bounded token. */
export function safeLabel(name: string): string {
  const bounded = name.length > 64 ? `${name.slice(0, 64)}…` : name;
  return JSON.stringify(bounded);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += await dirSizeBytes(full);
    } else {
      try {
        total += (await fs.lstat(full)).size;
      } catch {
        // vanished while counting: ignore
      }
    }
  }
  return total;
}

// =====================================================
// File stage
// =====================================================

interface FileStage {
  /** UUID names of directories removed (dry-run: would be removed) */
  deleted: string[];
  /** UUID names (lower case) whose removal failed */
  failedIds: Set<string>;
  /** UUID names (lower case) left in place because the entry is a symlink or not a directory */
  keptIds: Set<string>;
  bytesFreed: number;
  skippedUnsafe: number;
}

async function listCandidates(
  cropRoot: string,
  webPageId: string | undefined,
  stage: FileStage
): Promise<string[]> {
  if (webPageId) {
    const dir = await buildSafeCropDir(webPageId);
    let st;
    try {
      st = await fs.lstat(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      stage.skippedUnsafe++;
      stage.keptIds.add(webPageId.toLowerCase());
      logger.warn(
        `[purge-legacy-crops] left untouched (not a plain directory): ${truncateAuditTargetId(webPageId)}`
      );
      return [];
    }
    return [webPageId];
  }
  const names: string[] = [];
  for (const entry of await fs.readdir(cropRoot, { withFileTypes: true })) {
    if (!UUID_REGEX.test(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) {
      stage.skippedUnsafe++;
      if (UUID_REGEX.test(entry.name)) stage.keptIds.add(entry.name.toLowerCase());
      logger.warn(`[purge-legacy-crops] left untouched: ${safeLabel(entry.name)}`);
      continue;
    }
    names.push(entry.name);
  }
  return names;
}

/** errno code only (no path, no message): enough for the operator, carries no PII. */
function errnoCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "unknown";
}

/**
 * The crops directory must be a plain directory. Checked before the scan and again
 * before every removal, so a crops directory swapped for a symlink mid-run stops
 * the run instead of deleting through the link (TOCTOU).
 */
async function assertCropRootIsPlainDir(cropRoot: string): Promise<boolean> {
  let rootStat;
  try {
    rootStat = await fs.lstat(cropRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new PurgeAbortError(
      "[purge-legacy-crops] aborted: the crops directory is a symlink or not a directory"
    );
  }
  return true;
}

/** Fills `stage` as it goes, so a run that throws part-way still reports what it removed. */
async function runFileStage(cropRoot: string, args: CliArgs, stage: FileStage): Promise<boolean> {
  if (!(await assertCropRootIsPlainDir(cropRoot))) return false;

  for (const name of await listCandidates(cropRoot, args.webPageId, stage)) {
    const dir = await buildSafeCropDir(name);
    const size = await dirSizeBytes(dir);
    if (!args.dryRun) {
      await assertCropRootIsPlainDir(cropRoot);
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (error) {
        logger.warn(
          `[purge-legacy-crops] directory removal failed: ${truncateAuditTargetId(name)} ` +
            `code=${errnoCode(error)}`
        );
        stage.failedIds.add(name.toLowerCase());
        continue;
      }
    }
    stage.deleted.push(name);
    stage.bytesFreed += size;
  }
  return true;
}

// =====================================================
// DB stage
// =====================================================

interface CropRow {
  web_page_id: string;
  crop_storage_path: string;
}

async function selectSectionRows(prisma: PurgePrismaClient, id: string | null): Promise<CropRow[]> {
  return prisma.$queryRaw<CropRow[]>`
    SELECT sp.web_page_id::text AS web_page_id, se.crop_storage_path AS crop_storage_path
    FROM section_embeddings se
    JOIN section_patterns sp ON sp.id = se.section_pattern_id
    WHERE se.crop_storage_path IS NOT NULL
      AND (${id}::uuid IS NULL OR sp.web_page_id = ${id}::uuid)`;
}

async function selectPartRows(prisma: PurgePrismaClient, id: string | null): Promise<CropRow[]> {
  return prisma.$queryRaw<CropRow[]>`
    SELECT cp.web_page_id::text AS web_page_id, pe.crop_storage_path AS crop_storage_path
    FROM component_part_embeddings pe
    JOIN component_parts cp ON cp.id = pe.component_part_id
    WHERE pe.crop_storage_path IS NOT NULL
      AND (${id}::uuid IS NULL OR cp.web_page_id = ${id}::uuid)`;
}

async function countOrphans(prisma: PurgePrismaClient, names: readonly string[]): Promise<number> {
  let existing = 0;
  for (const ids of chunk(names, ID_CHUNK_SIZE)) {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id::text AS id FROM web_pages WHERE id = ANY(${ids}::uuid[])`;
    existing += rows.length;
  }
  return names.length - existing;
}

function outsideCropRoot(rows: readonly CropRow[], cropRoot: string): number {
  const prefix = cropRoot + path.sep;
  return rows.filter((r) => !path.resolve(r.crop_storage_path).startsWith(prefix)).length;
}

// =====================================================
// Entry point
// =====================================================

export async function runPurge(prisma: PurgePrismaClient, args: CliArgs): Promise<PurgeResult> {
  const cropRoot = await resolveCropRoot();

  // Preflight, before anything is deleted: every stored path must lie under the
  // resolved crops directory. A row pointing elsewhere means this run uses a
  // different screenshot root than the one that wrote the files; deleting here
  // would remove files the database does not reference while the audit row would
  // describe a deletion that did not happen. Nothing is deleted or recorded.
  const scope = args.webPageId ?? null;
  const sectionRows = await selectSectionRows(prisma, scope);
  const partRows = await selectPartRows(prisma, scope);
  const mismatch = outsideCropRoot(sectionRows, cropRoot) + outsideCropRoot(partRows, cropRoot);
  if (mismatch > 0) {
    logger.warn(
      `[purge-legacy-crops] aborted before deleting anything: ${mismatch} row(s) point ` +
        `outside the resolved crops directory. Check REFTRIX_SCREENSHOT_ROOT and re-run.`
    );
    return {
      dirsDeleted: 0,
      orphanDirs: 0,
      bytesFreed: 0,
      sectionRowsCleared: 0,
      partRowsCleared: 0,
      skippedUnsafe: 0,
      failed: 0,
      rootMismatchRows: mismatch,
    };
  }

  const stage: FileStage = {
    deleted: [],
    failedIds: new Set(),
    keptIds: new Set(),
    bytesFreed: 0,
    skippedUnsafe: 0,
  };
  const result: PurgeResult = {
    dirsDeleted: 0,
    orphanDirs: 0,
    bytesFreed: 0,
    sectionRowsCleared: 0,
    partRowsCleared: 0,
    skippedUnsafe: 0,
    failed: 0,
    rootMismatchRows: 0,
  };
  const syncStage = (): void => {
    result.dirsDeleted = stage.deleted.length;
    result.bytesFreed = stage.bytesFreed;
    result.skippedUnsafe = stage.skippedUnsafe;
    result.failed = stage.failedIds.size;
  };

  // Once anything may have been deleted, the audit row is written in `finally`,
  // even when a later step throws (Art.5(2) / Art.30: every run that deletes more
  // than 0 items leaves a record, with result "failure" when the run did not finish).
  let thrown: unknown;
  try {
    const exists = await runFileStage(cropRoot, args, stage);
    syncStage();
    result.orphanDirs = exists ? await countOrphans(prisma, stage.deleted) : 0;

    // Only pages whose directory was removed or never existed lose their stored path;
    // a directory that could not be removed or was left in place keeps its reference.
    const keep = (id: string): boolean =>
      stage.failedIds.has(id.toLowerCase()) || stage.keptIds.has(id.toLowerCase());
    const pageIds = [...new Set([...sectionRows, ...partRows].map((r) => r.web_page_id))].filter(
      (id) => !keep(id)
    );
    if (args.dryRun) {
      result.sectionRowsCleared = sectionRows.filter((r) => !keep(r.web_page_id)).length;
      result.partRowsCleared = partRows.filter((r) => !keep(r.web_page_id)).length;
    } else {
      for (const ids of chunk(pageIds, ID_CHUNK_SIZE)) {
        result.sectionRowsCleared += await prisma.$executeRaw`
          UPDATE section_embeddings SET crop_storage_path = NULL
          WHERE crop_storage_path IS NOT NULL
            AND section_pattern_id IN (
              SELECT id FROM section_patterns WHERE web_page_id = ANY(${ids}::uuid[]))`;
        result.partRowsCleared += await prisma.$executeRaw`
          UPDATE component_part_embeddings SET crop_storage_path = NULL
          WHERE crop_storage_path IS NOT NULL
            AND component_part_id IN (
              SELECT id FROM component_parts WHERE web_page_id = ANY(${ids}::uuid[]))`;
      }
    }
  } catch (error) {
    thrown = error;
    syncStage();
  } finally {
    await emitAudit(args, result, thrown !== undefined);
  }
  if (thrown !== undefined) throw thrown;
  return result;
}

/**
 * Best-effort, like every audit emit in this project: `AuditLogService.log()`
 * swallows its own write errors, so a failed write shows only as a warning.
 */
async function emitAudit(args: CliArgs, result: PurgeResult, aborted: boolean): Promise<void> {
  const processed = result.dirsDeleted + result.sectionRowsCleared + result.partRowsCleared;
  if (args.dryRun || processed === 0) return;
  try {
    await getAuditLogService().log({
      action: AUDIT_ACTION_CROP_LEGACY_BULK_DELETED,
      actor: AUDIT_ACTOR_CROP_LEGACY_PURGE,
      targetType: "web_page",
      targetId: truncateAuditTargetId(args.webPageId ?? "all"),
      details: {
        executionMode: "confirm",
        dirsDeleted: result.dirsDeleted,
        orphanDirs: result.orphanDirs,
        bytesFreed: result.bytesFreed,
        sectionRowsCleared: result.sectionRowsCleared,
        partRowsCleared: result.partRowsCleared,
        skippedUnsafe: result.skippedUnsafe,
        failed: result.failed,
        aborted,
      },
      result: aborted || isFailedRun(result) ? "failure" : "success",
    });
  } catch (error) {
    logger.warn(
      `[purge-legacy-crops] Art.30 audit emit failed (non-fatal): ${sanitizeErrorMessage(error)}`
    );
  }
}

/** A run that did not fully clean up must not look like a success. */
export function isFailedRun(result: PurgeResult): boolean {
  return result.failed > 0 || result.skippedUnsafe > 0 || result.rootMismatchRows > 0;
}

async function main(): Promise<void> {
  loadEnvLocal({ verbose: false });

  let args: CliArgs;
  try {
    args = parseArgs(process.argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const prisma = new PrismaClient();
  bootstrapAuditLogServiceForScript(prisma);

  console.log(
    `[purge-legacy-crops] mode=${args.dryRun ? "dry-run" : "CONFIRMED"}` +
      (args.webPageId ? ` webPageId=${truncateAuditTargetId(args.webPageId)}` : "")
  );
  if (!args.dryRun) console.log("[purge-legacy-crops] NOTE: run `pnpm db:backup` first.");

  try {
    const r = await runPurge(prisma as unknown as PurgePrismaClient, args);
    console.log(
      `[purge-legacy-crops] dirs=${r.dirsDeleted} orphanDirs=${r.orphanDirs} bytes=${r.bytesFreed} ` +
        `sectionRows=${r.sectionRowsCleared} partRows=${r.partRowsCleared} ` +
        `skippedUnsafe=${r.skippedUnsafe} failed=${r.failed} rootMismatchRows=${r.rootMismatchRows}`
    );
    if (args.dryRun && r.dirsDeleted + r.sectionRowsCleared + r.partRowsCleared > 0) {
      console.log("[purge-legacy-crops] dry-run complete. Re-run with --confirm to apply.");
    }
    if (isFailedRun(r)) process.exitCode = 1;
  } catch (error) {
    console.error(
      `[purge-legacy-crops] failed: ${
        error instanceof PurgeAbortError
          ? error.message
          : `${sanitizeErrorMessage(error)} code=${errnoCode(error)}`
      }`
    );
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && process.argv[1].includes("purge-legacy-crops")) {
  void main();
}
