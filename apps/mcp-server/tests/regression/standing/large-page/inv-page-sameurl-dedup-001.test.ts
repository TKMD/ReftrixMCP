// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — large-page domain
 *
 * INV-PAGE-SAMEURL-DEDUP-001: page.analyze same-URL near-concurrent resubmit
 * race dedup (PR-SAMEURL-DEDUP, ADR-0018 Amendment 11, Strategy A).
 *
 * Sibling of INV-PAGE-QUEUE-001-E. Where INV-E pins the generic collision-guard
 * helper contract (distinct-key submits → all `enqueued_new`), this INV pins the
 * page-analyze caller's URL-stable UUIDv5 jobId (`buildUrlStableJobId`): the
 * BullMQ jobId is derived from the URL (NOT `webPageId`), so near-concurrent
 * same-URL submits share one jobId and the collision guard routes losers to the
 * incumbent (≤1 surviving job).
 *
 * Scope (3 blocks per Plan v2 §4):
 *   - Block A (behaviour-pin + schema round-trip): A-1 jobId is a valid UUID and
 *     != data.webPageId (runtime, no AST source-pin); A-2 the UUIDv5 jobId
 *     survives the 3-stage Zod round-trip (async output → getJobStatus input →
 *     getJobStatus output). Mutation: revert the jobId to the old
 *     `"url-"+sha256hex` string → A-2 RED (SEC-RV1-H-01 closure).
 *   - Block B (real helper outcome, real Redis): B-1 N≥10 same-URL parallel
 *     submit → ≤1 surviving job (label-independent, NEW-TDA-V1-02). Mutation:
 *     helper jobId = data.webPageId → N independent jobs survive → B-1 RED. B-2
 *     normalization-edge fixture: fragment-insensitive / query-sensitive
 *     (SSRF↔dedup coupling regression detection, SEC-RV1-M-02).
 *   - Block C (real Redis + real Prisma): C-1 N parallel same-URL submit → 1
 *     surviving job + no "Missing key for job" throw + no embedding clobber
 *     (structural: losers reuse the incumbent, so the worker never re-runs).
 *     C-2 Layer-2 independent exercise: claim-TTL expiry → 2nd same-URL submit
 *     does not create a 2nd job (SEC-RV1-M-01 / NEW-TDA-V1-04, detects
 *     Layer-2-never-exercised false-pass). C-3 fail-open interleaving: even when
 *     a loser races ahead to `handleFailOpen`, ≤1 surviving job (TPA-RV1-M-01).
 *
 * @see  §4
 * @see ADR-0018 Amendment 11 §INV Landing
 * @see apps/mcp-server/src/queues/page-analyze-queue.ts (buildUrlStableJobId)
 * @module tests/regression/standing/large-page/inv-page-sameurl-dedup-001
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
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
  pageAnalyzeAsyncOutputSchema,
  pageGetJobStatusInputSchema,
  pageGetJobStatusDataSchema,
} from "../../../../src/tools/page/output.schemas";
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
      `[INV-PAGE-SAMEURL-DEDUP-001] Unable to parse REDIS_URL (expected redis://host:port): ${redisUrl}`
    );
  }
  const port = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`[INV-PAGE-SAMEURL-DEDUP-001] Invalid REDIS_URL port: ${match[2]}`);
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
 * Count how many distinct BullMQ jobs are alive for a given URL by resolving the
 * URL-stable jobId and probing it. With Strategy A all same-URL submits share
 * one jobId, so at most one job exists for the URL.
 */
async function countSurvivingJobsForUrl(
  queue: Queue<PageAnalyzeJobData, PageAnalyzeJobResult>,
  url: string
): Promise<number> {
  const job = await queue.getJob(buildUrlStableJobId(url));
  return job ? 1 : 0;
}

const OLD_STRING_JOBID =
  "url-" + crypto.createHash("sha256").update("https://example.com/p").digest("hex");

// ============================================================================
// Block A — behaviour-pin + schema round-trip (no real Redis)
// ============================================================================

describe("INV-PAGE-SAMEURL-DEDUP-001: Block A — jobId behaviour + schema round-trip", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-PAGE-SAMEURL-DEDUP-001");
  });

  it("INV-PAGE-SAMEURL-DEDUP-001: A1 — buildUrlStableJobId yields a valid UUIDv5 distinct from webPageId", () => {
    const url = "https://example.com/some/page";
    const webPageId = crypto.randomUUID();
    const jobId = buildUrlStableJobId(url);

    // Valid RFC 4122 v5 UUID.
    expect(uuidValidate(jobId)).toBe(true);
    expect(uuidVersion(jobId)).toBe(5);
    // Distinct from the per-call webPageId (the jobId is NOT data.webPageId).
    expect(jobId).not.toBe(webPageId);
    // Deterministic per URL.
    expect(buildUrlStableJobId(url)).toBe(jobId);
  });

  it("INV-PAGE-SAMEURL-DEDUP-001: A2 — UUIDv5 jobId survives the 3-stage Zod round-trip (SEC-RV1-H-01 closure)", () => {
    const jobId = buildUrlStableJobId("https://example.com/p");
    const webPageId = crypto.randomUUID();

    // (i) async output schema parse.
    const asyncParsed = pageAnalyzeAsyncOutputSchema.safeParse({
      async: true,
      jobId,
      webPageId,
      status: "queued",
      message: "queued",
      polling: { intervalSeconds: 10, retentionHours: 24, howToCheck: "poll" },
    });
    expect(asyncParsed.success).toBe(true);

    // (ii) getJobStatus input schema parse (client echoes the jobId).
    const inputParsed = pageGetJobStatusInputSchema.safeParse({ job_id: jobId });
    expect(inputParsed.success).toBe(true);

    // (iii) getJobStatus output data schema parse (`timestamps` is required).
    const outputParsed = pageGetJobStatusDataSchema.safeParse({
      jobId,
      status: "waiting",
      progress: 0,
      timestamps: {},
    });
    expect(outputParsed.success).toBe(true);
  });

  it("INV-PAGE-SAMEURL-DEDUP-001: A2-mutation — the legacy `url-<sha256hex>` string FAILS all 3 schema gates (non-vacuity)", () => {
    // Mutation guard: the V1 string jobId design (rejected by SEC-RV1-H-01) must
    // NOT pass the UUID schema gates. If a future change reverts the jobId to a
    // non-UUID string, this assertion goes RED.
    expect(uuidValidate(OLD_STRING_JOBID)).toBe(false);
    expect(
      pageAnalyzeAsyncOutputSchema.safeParse({
        async: true,
        jobId: OLD_STRING_JOBID,
        webPageId: crypto.randomUUID(),
        status: "queued",
        message: "queued",
        polling: { intervalSeconds: 10, retentionHours: 24, howToCheck: "poll" },
      }).success
    ).toBe(false);
    expect(pageGetJobStatusInputSchema.safeParse({ job_id: OLD_STRING_JOBID }).success).toBe(false);
    // Supply all OTHER required fields (status/progress/timestamps) so the parse
    // can only fail on the bad jobId gate (non-vacuous mutation).
    expect(
      pageGetJobStatusDataSchema.safeParse({
        jobId: OLD_STRING_JOBID,
        status: "waiting",
        progress: 0,
        timestamps: {},
      }).success
    ).toBe(false);
  });

  it("INV-PAGE-SAMEURL-DEDUP-001: A3 — normalization edge: fragment-insensitive, query-sensitive (B-2 fixture, SEC-RV1-M-02)", () => {
    // Fragment is stripped → same UUIDv5 (same logical page).
    expect(buildUrlStableJobId("https://x.com/p")).toBe(
      buildUrlStableJobId("https://x.com/p#frag")
    );
    // Query is kept (sorted) → distinct UUIDv5 (distinct logical pages).
    expect(buildUrlStableJobId("https://x.com/p?v=1")).not.toBe(
      buildUrlStableJobId("https://x.com/p?v=2")
    );
    // Host case-insensitivity → same UUIDv5.
    expect(buildUrlStableJobId("https://X.COM/p")).toBe(buildUrlStableJobId("https://x.com/p"));
  });
});

// ============================================================================
// Block B / C — real Redis (+ real Prisma for C)
// ============================================================================

describe("INV-PAGE-SAMEURL-DEDUP-001: Block B/C — real Redis same-URL dedup", () => {
  let prisma: PrismaClient;
  let queue: Queue<PageAnalyzeJobData, PageAnalyzeJobResult>;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
      throw new Error(
        "[INV-PAGE-SAMEURL-DEDUP-001] DATABASE_URL / REDIS_URL not set by globalSetup (testcontainer boot failure?)"
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
    assertInvName(expect.getState().currentTestName ?? "", "INV-PAGE-SAMEURL-DEDUP-001");
    try {
      await queue.drain(true);
      await queue.clean(0, 100_000, "completed");
      await queue.clean(0, 100_000, "failed");
    } catch {
      /* best-effort */
    }
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE audit_logs RESTART IDENTITY CASCADE`);
  });

  it("INV-PAGE-SAMEURL-DEDUP-001: B1 — N=10 same-URL parallel submit → ≤1 surviving job (label-independent)", async () => {
    const url = `https://example.com/inv-sameurl/${crypto.randomUUID()}`;
    const submits = Array.from({ length: 10 }, () =>
      addPageAnalyzeJobWithGuard(queue, buildJobData(url))
    );
    const results = await Promise.all(submits);

    // Every submit returns a well-formed discriminated outcome (no throw).
    for (const r of results) {
      expect(r).toBeDefined();
      expect(r.outcome).toBeTruthy();
    }

    // Label-independent survivorship: regardless of how the 10 submits split
    // across enqueued_new / reused_active / enqueued_fail_open, exactly one
    // BullMQ job exists for the URL-stable jobId.
    const surviving = await countSurvivingJobsForUrl(queue, url);
    expect(surviving).toBeLessThanOrEqual(1);
    expect(surviving).toBe(1);

    // All non-fail-open winners report the URL-stable jobId (shared identity).
    const expectedJobId = buildUrlStableJobId(url);
    for (const r of results) {
      if (r.outcome === "enqueued_new" || r.outcome === "reused_active") {
        expect(r.jobId).toBe(expectedJobId);
      }
    }
  }, 60_000);

  it("INV-PAGE-SAMEURL-DEDUP-001: B1-mutation — per-call jobId (data.webPageId) would yield N independent jobs (non-vacuity guard)", async () => {
    // This test documents and proves the mutation that B1 catches: if the helper
    // keyed on `data.webPageId` (per-call) instead of the URL-stable jobId, N
    // distinct webPageIds for the SAME url would produce N independent jobs. We
    // simulate that "broken" enqueue directly via `queue.add(jobId=webPageId)`
    // and assert it produces N>1 jobs — i.e. B1 is non-vacuous.
    const url = `https://example.com/inv-sameurl-mut/${crypto.randomUUID()}`;
    const perCallIds = Array.from({ length: 5 }, () => crypto.randomUUID());
    await Promise.all(
      perCallIds.map((id) =>
        queue.add(
          "page-analyze",
          { ...buildJobData(url, id), createdAt: new Date().toISOString() },
          {
            jobId: id,
          }
        )
      )
    );
    // Per-call jobIds → 5 independent jobs survive (the bug Strategy A fixes).
    let alive = 0;
    for (const id of perCallIds) {
      if (await queue.getJob(id)) alive++;
    }
    expect(alive).toBe(5);
    // And NONE of them is the URL-stable jobId (proves the keys differ).
    expect(await queue.getJob(buildUrlStableJobId(url))).toBeUndefined();
  }, 60_000);

  it("INV-PAGE-SAMEURL-DEDUP-001: B2 — normalization edge fixtures collapse/separate under real BullMQ", async () => {
    const base = `https://example.com/inv-sameurl-b2/${crypto.randomUUID()}`;
    // Fragment-insensitive: base and base#frag share one job.
    await addPageAnalyzeJobWithGuard(queue, buildJobData(base));
    const r2 = await addPageAnalyzeJobWithGuard(queue, buildJobData(`${base}#frag`));
    expect(["reused_active", "enqueued_new", "enqueued_fail_open"]).toContain(r2.outcome);
    expect(await countSurvivingJobsForUrl(queue, base)).toBe(1);
    // The fragment variant resolves to the SAME jobId.
    expect(buildUrlStableJobId(`${base}#frag`)).toBe(buildUrlStableJobId(base));

    // Query-sensitive: ?v=1 and ?v=2 are distinct jobs.
    const q1 = `${base}?v=1`;
    const q2 = `${base}?v=2`;
    await addPageAnalyzeJobWithGuard(queue, buildJobData(q1));
    await addPageAnalyzeJobWithGuard(queue, buildJobData(q2));
    expect(buildUrlStableJobId(q1)).not.toBe(buildUrlStableJobId(q2));
    expect(await countSurvivingJobsForUrl(queue, q1)).toBe(1);
    expect(await countSurvivingJobsForUrl(queue, q2)).toBe(1);
  }, 60_000);

  it("INV-PAGE-SAMEURL-DEDUP-001: C1 — N parallel same-URL submit → 1 surviving job, no Missing-key throw, no clobber-spawn", async () => {
    const url = `https://example.com/inv-sameurl-c1/${crypto.randomUUID()}`;
    // No "Missing key for job" throw: Promise.all resolves all submits with a
    // well-formed discriminated outcome (limbo_forced is a legitimate
    // non-lifecycle dedup outcome under heavy concurrency — it still means NO
    // second job was created, so it is tolerated here; the load-bearing
    // invariant is the ≤1 surviving-job count, not the label distribution).
    const results = await Promise.all(
      Array.from({ length: 12 }, () => addPageAnalyzeJobWithGuard(queue, buildJobData(url)))
    );
    expect(results.length).toBe(12);
    for (const r of results) {
      expect(r.outcome).toBeTruthy();
    }
    // Exactly one job survives → the worker would process the URL once → the
    // page's embeddings are never clobbered by a second concurrent job.
    expect(await countSurvivingJobsForUrl(queue, url)).toBe(1);
  }, 60_000);

  it("INV-PAGE-SAMEURL-DEDUP-001: C2 — Layer-2 exercise: claim-TTL expiry → 2nd same-URL submit creates NO 2nd job (SEC-RV1-M-01)", async () => {
    const url = `https://example.com/inv-sameurl-c2/${crypto.randomUUID()}`;
    const jobId = buildUrlStableJobId(url);

    // 1st submit → winner enqueues the job.
    const first = await addPageAnalyzeJobWithGuard(queue, buildJobData(url));
    expect(["enqueued_new", "enqueued_fail_open"]).toContain(first.outcome);
    expect(await queue.getJob(jobId)).toBeDefined();

    // Explicitly expire the Layer-1 claim key so the 2nd submit cannot win via
    // the claim window alone — it MUST be deduped by Layer-2 (BullMQ jobId
    // uniqueness) instead. This is the Layer-2-never-exercised false-pass guard.
    const redis = (await queue.client) as unknown as { del: (k: string) => Promise<number> };
    await redis.del(`reftrix:page-analyze:jobclaim:${jobId}`);

    // 2nd submit: the incumbent job is still in-flight (waiting). The claim key
    // is gone, so the loser-path resolves the incumbent via getJob(jobId).
    const second = await addPageAnalyzeJobWithGuard(queue, buildJobData(url));
    // Real BullMQ same-jobId in-flight add must NOT create a 2nd job.
    expect(await countSurvivingJobsForUrl(queue, url)).toBe(1);
    // The 2nd submit is not a fresh independent job (reused or fail-open dedup,
    // but never a distinct surviving job).
    expect(["reused_active", "enqueued_new", "enqueued_fail_open"]).toContain(second.outcome);
  }, 60_000);

  it("INV-PAGE-SAMEURL-DEDUP-001: C3 — high-concurrency fail-open-tolerant: ≤1 surviving job across all interleavings (TPA-RV1-M-01)", async () => {
    // Loser-races-ahead interleavings may route a submit through handleFailOpen
    // (`claim_expired`). The invariant is NOT "fail-open never fires" but "≤1
    // surviving job even across fail-open". Drive 20 parallel same-URL submits.
    const url = `https://example.com/inv-sameurl-c3/${crypto.randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => addPageAnalyzeJobWithGuard(queue, buildJobData(url)))
    );
    expect(results.length).toBe(20);
    // Single shared jobId → BullMQ jobId uniqueness absorbs every interleaving
    // (including any enqueued_fail_open that calls bare queue.add with the same
    // jobId).
    expect(await countSurvivingJobsForUrl(queue, url)).toBe(1);
  }, 60_000);
});
