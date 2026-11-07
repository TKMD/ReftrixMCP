// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fixtures for the screenshot retention standing tests (gdpr-delete domain).
 * screenshot 保持期限の standing test 用 fixture (実 DB + 実 FS、test 専用 root のみ)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type { PrismaClient } from "@prisma/client";

import { createScreenshotFixtureFile } from "./gdpr-test-fixtures";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The values of `EmbeddingBackfillStatus`, written out on purpose (independent of the code's classifier). */
export const TERMINAL_STATUSES = [
  "completed",
  "failed",
  "not_required",
  "skipped_screenshot_missing",
] as const;
export const NON_TERMINAL_STATUSES = [
  "queued",
  "in_progress",
  "skipped_fork_error",
  "skipped_memory_pressure",
  "failed_with_known_reason",
] as const;

export interface RetentionSeed {
  status: string;
  /** `web_pages.analysis_status` (default "completed") */
  analysis?: string;
  /** age of `updated_at` in days (default 8) */
  ageDays?: number;
  /** write the PNG (default true) */
  withFile?: boolean;
}

export interface RetentionSeeded {
  id: string;
  filePath: string;
}

export async function seedRetentionPage(
  prisma: PrismaClient,
  seed: RetentionSeed
): Promise<RetentionSeeded> {
  const id = crypto.randomUUID();
  const withFile = seed.withFile !== false;
  // createScreenshotFixtureFile refuses a non test-only root, so this never touches a real root.
  const filePath = createScreenshotFixtureFile(id);
  if (!withFile) fs.rmSync(filePath);
  const updatedAt = new Date(Date.now() - (seed.ageDays ?? 8) * DAY_MS);
  await prisma.$executeRawUnsafe(
    `INSERT INTO web_pages
       (id, url, source_type, usage_scope, screenshot_storage_path,
        embedding_backfill_status, analysis_status, updated_at)
     VALUES ($1::uuid, $2, 'user_provided', 'inspiration_only', $3,
             $4::"EmbeddingBackfillStatus", $5, $6::timestamptz)`,
    id,
    `https://example.com/retention/${id}`,
    filePath,
    seed.status,
    seed.analysis ?? "completed",
    updatedAt.toISOString()
  );
  return { id, filePath };
}

export async function readStoragePath(prisma: PrismaClient, id: string): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ p: string | null }>>(
    `SELECT screenshot_storage_path AS p FROM web_pages WHERE id = $1::uuid`,
    id
  );
  return rows[0]?.p ?? null;
}

export interface RetentionAuditRow {
  actor: string;
  target_id: string | null;
  result: string;
  details: Record<string, unknown>;
}

export async function readRetentionAuditRows(
  prisma: PrismaClient,
  action: string
): Promise<RetentionAuditRow[]> {
  return prisma.$queryRawUnsafe<RetentionAuditRow[]>(
    `SELECT actor, target_id, result, details FROM audit_logs WHERE action = $1 ORDER BY timestamp`,
    action
  );
}
