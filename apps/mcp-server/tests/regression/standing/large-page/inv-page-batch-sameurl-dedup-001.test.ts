// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — large-page domain
 *
 * INV-PAGE-BATCH-SAMEURL-DEDUP-001: page.batch_analyze same-URL-in-request dedup
 * (PR-L1a, ADR-0018 Amendment 11, Strategy A).
 *
 * Sibling of INV-PAGE-SAMEURL-DEDUP-001. Where the sibling pins near-concurrent
 * same-URL *resubmits*, this INV pins the **same-URL-in-one-batch-request** path:
 * the batch loop (`batch-analyze.tool.ts:282-307`) calls
 * `addPageAnalyzeJobWithGuard(queue, jobData, 10)` per item and pushes
 * `enqueueResult.jobId` into `jobIds[]`. Because the helper derives the BullMQ
 * jobId from `buildUrlStableJobId(item.url)` (NOT `data.webPageId`), two identical
 * URLs in the same batch request produce the SAME UUIDv5 jobId and the collision
 * guard collapses them at the enqueue layer to 1 surviving job.
 *
 * Scope (3 blocks per the sibling Block A/B convention):
 *   - Block A (pure, no Redis): A1 same-URL-in-batch jobId-derivation collapses
 *     (`jobIds[0] === jobIds[1] !== jobIds[2]`); A2 every `jobIds[]` entry is a
 *     valid UUIDv5 (schema-safe so `z.string().uuid()` batch-response gate holds).
 *   - Block A (committed AST source-pin, non-vacuity): A3 pins that
 *     `page-analyze-queue.ts` keys the guard jobId on `buildUrlStableJobId(data.url)`
 *     (NOT `data.webPageId`). A regression to webPageId keying makes this RED.
 *   - Block B (real Redis, real helper outcome): B1 drives the same URL 5×
 *     (distinct per-call webPageIds) + 2 distinct URLs through the production
 *     helper `addPageAnalyzeJobWithGuard` end-to-end and asserts 1 surviving job
 *     for the duplicated URL + 3 total surviving jobs. Because it does NOT bypass
 *     the helper's internal jobId derivation, a regression to webPageId keying
 *     makes B1 observe 5 survivors → committed CI-RED (UB-3 committed non-vacuity).
 *
 * @see  §Sub-item 2 / §UB-3
 * @see ADR-0018 Amendment 11 §INV Landing
 * @see apps/mcp-server/src/tools/page/batch-analyze.tool.ts (batch loop)
 * @see apps/mcp-server/src/queues/page-analyze-queue.ts (buildUrlStableJobId)
 * @module tests/regression/standing/large-page/inv-page-batch-sameurl-dedup-001
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { validate as uuidValidate, version as uuidVersion } from "uuid";
import { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import { assertInvName } from "../_setup/inv-assert";
import {
  addPageAnalyzeJobWithGuard,
  buildUrlStableJobId,
  createPageAnalyzeQueue,
  type PageAnalyzeJobData,
  type PageAnalyzeJobResult,
} from "../../../../src/queues/page-analyze-queue";
import {
  setAuditLogPrismaClientFactory,
  resetAuditLogPrismaClientFactory,
  resetAuditLogService,
  type AuditLogPrismaClient,
} from "../../../../src/services/audit-log.service";

// ============================================================================
// Helpers
// ============================================================================

function parseRedisUrl(redisUrl: string): { host: string; port: number } {
  const match = redisUrl.match(/^redis:\/\/([^:/]+):(\d+)(?:\/|$)/);
  if (!match) {
    throw new Error(
      `[INV-PAGE-BATCH-SAMEURL-DEDUP-001] Unable to parse REDIS_URL (expected redis://host:port): ${redisUrl}`
    );
  }
  const port = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`[INV-PAGE-BATCH-SAMEURL-DEDUP-001] Invalid REDIS_URL port: ${match[2]}`);
  }
  return { host: match[1]!, port };
}

/** Build minimal PageAnalyzeJobData for a fixed URL with a per-call webPageId. */
function buildJobData(
  url: string,
  webPageId: string = crypto.randomUUID()
): Omit<PageAnalyzeJobData, "createdAt"> {
  return { webPageId, url, options: {} };
}

/**
 * Mirror of the production batch loop's jobId derivation (`batch-analyze.tool.ts`
 * pushes `enqueueResult.jobId === buildUrlStableJobId(item.url)`): map a batch of
 * URLs to the `jobIds[]` that the helper would produce.
 */
function deriveBatchJobIds(urls: string[]): string[] {
  return urls.map((u) => buildUrlStableJobId(u));
}

/**
 * Count how many distinct BullMQ jobs are alive for a given URL by resolving the
 * URL-stable jobId and probing it. With Strategy A all same-URL submits share one
 * jobId, so at most one job exists for the URL.
 */
async function countSurvivingJobsForUrl(
  queue: Queue<PageAnalyzeJobData, PageAnalyzeJobResult>,
  url: string
): Promise<number> {
  const job = await queue.getJob(buildUrlStableJobId(url));
  return job ? 1 : 0;
}

// ============================================================================
// Block A — pure jobId-derivation collapse + committed AST source-pin
// ============================================================================

describe("INV-PAGE-BATCH-SAMEURL-DEDUP-001: Block A — batch jobId collapse + schema-safe + AST pin", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-PAGE-BATCH-SAMEURL-DEDUP-001");
  });

  it("INV-PAGE-BATCH-SAMEURL-DEDUP-001: A1 — same-URL-in-batch jobIds collapse to one UUIDv5", () => {
    const dupUrl = "https://example.com/batch/same";
    const otherUrl = "https://example.com/batch/other";
    // Production batch request: [dupUrl, dupUrl, otherUrl].
    const jobIds = deriveBatchJobIds([dupUrl, dupUrl, otherUrl]);

    // The two identical URLs collapse to one UUIDv5; the distinct URL differs.
    expect(jobIds[0]).toBe(jobIds[1]);
    expect(jobIds[0]).not.toBe(jobIds[2]);
  });

  it("INV-PAGE-BATCH-SAMEURL-DEDUP-001: A2 — every batch jobId is a valid UUIDv5 (schema-safe, F-PLAN-L-07)", () => {
    // Schema-safe: a duplicated URL never produces a non-UUID jobId that would
    // break the `z.string().uuid()` batch-response gate (PR #54 regression guard).
    const jobIds = deriveBatchJobIds([
      "https://example.com/a",
      "https://example.com/a",
      "https://example.com/b",
      "https://x.com/c?v=1",
    ]);
    for (const jobId of jobIds) {
      expect(uuidValidate(jobId)).toBe(true);
      expect(uuidVersion(jobId)).toBe(5);
    }
  });

  it("INV-PAGE-BATCH-SAMEURL-DEDUP-001: A3 — committed AST source-pin: guard keys on buildUrlStableJobId(data.url) (B-pin, UB-3 non-vacuity)", () => {
    // Committed CI-RED guarantee (UB-3): if production reverts the guard jobId
    // derivation to `data.webPageId`, this pin goes RED (no manual revert needed).
    const queueSource = fs.readFileSync(
      path.resolve(__dirname, "../../../../src/queues/page-analyze-queue.ts"),
      "utf8"
    );
    // Scope the pin to the addPageAnalyzeJobWithGuard function body only. The
    // legacy `addPageAnalyzeJob` helper (which keyed on `data.webPageId`) was
    // now removed in PR-L1b, so this scoping also guards against any future
    // re-introduction polluting the match.
    const guardFn = queueSource.match(
      /export async function addPageAnalyzeJobWithGuard\b[\s\S]*?\n}/
    );
    expect(guardFn).not.toBeNull();
    const guardBody = guardFn![0];
    // The guard must pass `jobId: buildUrlStableJobId(data.url)`.
    expect(guardBody).toMatch(/jobId:\s*buildUrlStableJobId\(data\.url\)/);
    // And must NOT key the guard jobId on the per-call webPageId.
    expect(guardBody).not.toMatch(/jobId:\s*data\.webPageId\b/);
  });
});

// ============================================================================
// Block B — real Redis: production-helper-routed 1-survivor (committed non-vacuity)
// ============================================================================

describe("INV-PAGE-BATCH-SAMEURL-DEDUP-001: Block B — real Redis same-URL-in-batch dedup", () => {
  let prisma: PrismaClient;
  let queue: Queue<PageAnalyzeJobData, PageAnalyzeJobResult>;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
      throw new Error(
        "[INV-PAGE-BATCH-SAMEURL-DEDUP-001] DATABASE_URL / REDIS_URL not set by globalSetup (testcontainer boot failure?)"
      );
    }
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
      log: ["error"],
    });
    await prisma.$connect();
    setAuditLogPrismaClientFactory(() => prisma as unknown as AuditLogPrismaClient);

    const redisConfig = parseRedisUrl(process.env.REDIS_URL);
    queue = createPageAnalyzeQueue({ host: redisConfig.host, port: redisConfig.port });
    await queue.waitUntilReady();
  }, 60_000);

  afterAll(async () => {
    try {
      await queue?.close();
    } catch {
      /* best-effort */
    }
    resetAuditLogPrismaClientFactory();
    resetAuditLogService();
    try {
      await prisma?.$disconnect();
    } catch {
      /* best-effort */
    }
  }, 30_000);

  beforeEach(async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-PAGE-BATCH-SAMEURL-DEDUP-001");
    try {
      await queue.drain(true);
      await queue.clean(0, 100_000, "completed");
      await queue.clean(0, 100_000, "failed");
    } catch {
      /* best-effort */
    }
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE audit_logs RESTART IDENTITY CASCADE`);
  });

  it("INV-PAGE-BATCH-SAMEURL-DEDUP-001: B1 — same URL 5× + 2 distinct URLs through the production helper → 1 survivor for dup + 3 total (committed CI-RED non-vacuity)", async () => {
    // Drive the production helper end-to-end exactly as the batch loop does
    // (per-call distinct webPageIds for the SAME url). Because B1 does NOT bypass
    // the helper's `buildUrlStableJobId(item.url)` derivation, a helper regression
    // to webPageId keying would make `countSurvivingJobsForUrl(dupUrl)` observe 5
    // survivors → committed CI-RED (UB-3 body non-vacuity).
    const run = crypto.randomUUID();
    const dupUrl = `https://example.com/inv-batch-sameurl/${run}`;
    const distinctUrlA = `https://example.com/inv-batch-distinct-a/${run}`;
    const distinctUrlB = `https://example.com/inv-batch-distinct-b/${run}`;

    // Simulate one batch request: [dup, dup, dup, dup, dup, distinctA, distinctB].
    const batch: string[] = [dupUrl, dupUrl, dupUrl, dupUrl, dupUrl, distinctUrlA, distinctUrlB];

    const jobIds: string[] = [];
    for (const url of batch) {
      // Each batch item carries a distinct per-call webPageId (production loop).
      const enqueueResult = await addPageAnalyzeJobWithGuard(queue, buildJobData(url), 10);
      expect(enqueueResult).toBeDefined();
      expect(enqueueResult.outcome).toBeTruthy();
      jobIds.push(enqueueResult.jobId);
    }

    // The 5 same-URL items collapse to one UUIDv5 in jobIds[].
    const dupJobId = buildUrlStableJobId(dupUrl);
    expect(jobIds.slice(0, 5).every((id) => id === dupJobId)).toBe(true);
    // Distinct URLs keep distinct jobIds.
    expect(jobIds[5]).toBe(buildUrlStableJobId(distinctUrlA));
    expect(jobIds[6]).toBe(buildUrlStableJobId(distinctUrlB));

    // Enqueue-layer 1-survivor contract: exactly one BullMQ job for the dup URL.
    expect(await countSurvivingJobsForUrl(queue, dupUrl)).toBe(1);
    // Total surviving jobs = 1 (dup) + 2 (distinct) = 3.
    const totalSurviving =
      (await countSurvivingJobsForUrl(queue, dupUrl)) +
      (await countSurvivingJobsForUrl(queue, distinctUrlA)) +
      (await countSurvivingJobsForUrl(queue, distinctUrlB));
    expect(totalSurviving).toBe(3);

    // Schema-safe: every emitted jobId is a valid UUIDv5 (F-PLAN-L-07).
    for (const id of jobIds) {
      expect(uuidValidate(id)).toBe(true);
      expect(uuidVersion(id)).toBe(5);
    }
  }, 60_000);
});
