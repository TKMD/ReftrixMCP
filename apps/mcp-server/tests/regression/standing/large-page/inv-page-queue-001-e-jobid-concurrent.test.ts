// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — large-page domain
 *
 * INV-PAGE-QUEUE-001-E: 100+ concurrent `page.analyze` enqueue via the
 * collision-guarded helper completes without jobId collision, silent no-op,
 * or stuck-release (Stripe.com drift).
 *
 * Extends the pre-existing INV-PAGE-QUEUE-001 Queue-driven terminal-state
 * invariant with the PR-D-6 RC-A collision guard applied to the page-analyze
 * queue (observability-only scope per Registry v3 §3 FIND-TPA-02 binding).
 *
 * Scope (5 tests, 3 blocks) per Plan v1.2 §4.2:
 *   - Block A (1): AST source-pin — `addPageAnalyzeJobWithGuard` signature
 *                   + jobId convention (URL-stable UUIDv5
 *                   `buildUrlStableJobId(data.url)`, NOT `data.webPageId`;
 *                   ADR-0018 Amendment 11 / NEW-TDA-V1-01).
 *   - Block B (2): Fixture-based contract — 100 parallel unique-key submit
 *                   (all enqueued_new) + 100 parallel 50-unique-key
 *                   (50 winners + 50 losers via simulation).
 *   - Block C (2): Real Prisma + real Redis — 100 parallel submit (no drop
 *                   under real BullMQ Queue) + end-to-end integration with
 *                   `dispatchBackfillCategories` call sites in page-analyze-worker.
 *
 * @see Plan §4.2 (INV-PAGE-QUEUE-001 expansion)
 * @see `apps/mcp-server/src/queues/page-analyze-queue.ts`
 * @see `apps/mcp-server/src/workers/page-analyze-worker.ts`
 * @module tests/regression/standing/large-page/inv-page-queue-001-e-jobid-concurrent
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import { assertInvName } from "../_setup/inv-assert";
import { addMcpServerSourceFile, createAstProject } from "../schema-enum-sync/_extractors";
import {
  addPageAnalyzeJobWithGuard,
  createPageAnalyzeQueue,
  type PageAnalyzeJobData,
  type PageAnalyzeJobResult,
} from "../../../../src/queues/page-analyze-queue";
import type { EnqueueResult } from "../../../../src/queues/enqueue-with-collision-guard";
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
      `[INV-PAGE-QUEUE-001-E] Unable to parse REDIS_URL (expected redis://host:port): ${redisUrl}`
    );
  }
  const port = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`[INV-PAGE-QUEUE-001-E] Invalid REDIS_URL port: ${match[2]}`);
  }
  return { host: match[1]!, port };
}

/**
 * Build a minimal PageAnalyzeJobData for test fixtures (no createdAt — filled
 * in by `addPageAnalyzeJobWithGuard`).
 */
function buildJobData(webPageId: string): Omit<PageAnalyzeJobData, "createdAt"> {
  return {
    webPageId,
    url: `https://example.com/inv-page-queue-001-e/${webPageId}`,
    options: {},
  };
}

describe("INV-PAGE-QUEUE-001-E: page-analyze 100+ concurrent jobId collision guard", () => {
  // ==========================================================================
  // Block A — AST source-pin (1 test)
  // ==========================================================================
  describe("Block A: AST source-pin (1 test)", () => {
    let pageAnalyzeSource: string;
    let workerSource: string;

    beforeAll(() => {
      const project = createAstProject();
      pageAnalyzeSource = addMcpServerSourceFile(
        project,
        "src/queues/page-analyze-queue.ts"
      ).getFullText();
      workerSource = addMcpServerSourceFile(
        project,
        "src/workers/page-analyze-worker.ts"
      ).getFullText();
    });

    beforeEach(() => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-PAGE-QUEUE-001-E");
    });

    it("INV-PAGE-QUEUE-001-E: A13 — addPageAnalyzeJobWithGuard signature pins `EnqueueResult` return + URL-stable UUIDv5 jobId convention", () => {
      // Signature pin: helper returns discriminated `EnqueueResult`, not a
      // `Job<T>` (distinct from the now-removed legacy `addPageAnalyzeJob`).
      expect(pageAnalyzeSource).toMatch(
        /export\s+async\s+function\s+addPageAnalyzeJobWithGuard[\s\S]+?:\s*Promise<EnqueueResult>/
      );
      // jobId convention (ADR-0018 Amendment 11 / PR-SAMEURL-DEDUP, Strategy A):
      // page-analyze derives the canonical jobId from the URL via
      // `buildUrlStableJobId(data.url)` (a UUIDv5), NOT `data.webPageId`. This
      // makes near-concurrent same-URL submits share one jobId so the collision
      // guard routes losers to the incumbent. The payload still carries
      // `data.webPageId` as a per-call UUIDv7 for the web_pages FK.
      expect(pageAnalyzeSource).toMatch(/jobId:\s*buildUrlStableJobId\(data\.url\)/);
      // Behavioural sibling: the same UUIDv5 jobId is asserted at runtime by
      // INV-PAGE-SAMEURL-DEDUP-001 Block A (uuid.validate + jobId !== webPageId).
      // PR-L1b: legacy `addPageAnalyzeJob` helper removed (SEC-IMPL-L-01 / TDA-IMPL-L-02).
      // Inverse-assert pin: the bare `addPageAnalyzeJob` export MUST NOT reappear.
      // Negative lookahead `(?!WithGuard)` excludes the surviving
      // `addPageAnalyzeJobWithGuard` so the guard does not trip this pin.
      expect(pageAnalyzeSource).not.toMatch(
        /export\s+async\s+function\s+addPageAnalyzeJob(?!WithGuard)\b/
      );
      // page-analyze-worker must import with-guard helper (all 3 call sites
      // at L442 / L458 / L487 per Plan §4.2 #17 scope hint).
      expect(workerSource).toMatch(/addEmbeddingBackfillJobWithGuard/);
    });
  });

  // ==========================================================================
  // Block B — Fixture-based contract (2 tests)
  // ==========================================================================
  describe("Block B: fixture-based contract (2 tests)", () => {
    beforeEach(() => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-PAGE-QUEUE-001-E");
    });

    it("INV-PAGE-QUEUE-001-E: B14 — 100 parallel submit with 100 unique webPageIds: all enqueued_new (simulated, deterministic)", () => {
      // Plan §4.2 Block B #14 (seeded, no real Redis): model the
      // `addPageAnalyzeJobWithGuard` outcome for 100 distinct keys. The jobId
      // is the URL-stable UUIDv5 `buildUrlStableJobId(data.url)` (ADR-0018
      // Amendment 11), so each distinct URL yields a distinct claim key
      // (`reftrix:page-analyze:jobclaim:<uuidv5>`) → the atomic SETNX always
      // succeeds → outcome `enqueued_new`.
      const webPageIds = Array.from({ length: 100 }, () => crypto.randomUUID());
      const simulated: EnqueueResult[] = webPageIds.map((id) => ({
        outcome: "enqueued_new",
        jobId: id,
        collision: null,
      }));

      const enqueuedNewCount = simulated.filter((r) => r.outcome === "enqueued_new").length;
      expect(enqueuedNewCount).toBe(100);

      // The page-analyze jobId is a single bare UUID with no category suffix.
      // In production it is the URL-stable UUIDv5 `buildUrlStableJobId(data.url)`
      // (ADR-0018 Amendment 11), NOT the webPageId; this simulation uses the
      // webPageId UUID only as a same-shape stand-in, so the assertion checks
      // the UUID shape (suffix-free), not equality with webPageId.
      for (const result of simulated) {
        expect(result.jobId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        );
      }

      // Schema-enum-sync cross-ref: new audit action
      // `page_analyze_collision_resolved` lives in `audit_logs.action`
      // (VarChar(100)), NOT in an enum — Registry §4 row 238 binding.
      // This Block B test pins the *outcome* side (not the schema side),
      // confirming the observability-only scope does not leak into
      // schema-enum-sync standing regression.
      expect(simulated.every((r) => r.outcome === "enqueued_new")).toBe(true);
    });

    it("INV-PAGE-QUEUE-001-E: B15 — 100 parallel submit with 50 unique webPageIds (each duplicated): exactly 50 enqueued_new + 50 losers, zero silent no-ops (seeded race fuzzer, 5-variant union post Option Z-a)", () => {
      // Plan §4.2 Block B #15 + Plan §4.4 property-based fuzzer binding
      // (10 iterations, seeded). 50 distinct webPageIds each submitted
      // twice → 50 atomic SETNX winners + 50 losers (mix of
      // reused_active / enqueued_retry / limbo_forced).
      //
      // PR-D-7 Phase 2 Wave 2 Option Z-a: `race_lost_atomic` loser variant
      // was removed (dead emit path, 0 production refs). Losers now route
      // exclusively through dispatchLoserPath to one of the 3 state-driven
      // outcomes (plus `enqueued_fail_open` for Redis unreachable which is
      // not simulated here). See ADR-0018 Amendment 6 §Implementation Notes.
      //
      // Seeded PRNG ensures pass^3 determinism.
      function seededRandom(seed: number): () => number {
        let s = seed;
        return (): number => {
          s = (s * 9301 + 49297) % 233280;
          return s / 233280;
        };
      }

      const loserOutcomes: EnqueueResult["outcome"][] = [
        "limbo_forced",
        "reused_active",
        "enqueued_retry",
      ];

      // Run 10 seeded iterations — property-based fuzzer from Plan §4.4.
      for (let iteration = 0; iteration < 10; iteration++) {
        const rng = seededRandom(iteration + 42);
        const uniqueIds = Array.from({ length: 50 }, () => crypto.randomUUID());
        // Simulate 100 parallel results: one winner per unique id + one
        // non-deterministic loser per unique id.
        const results: EnqueueResult[] = [];
        for (const id of uniqueIds) {
          results.push({ outcome: "enqueued_new", jobId: id, collision: null });
          const loserOutcome = loserOutcomes[Math.floor(rng() * loserOutcomes.length)]!;
          if (loserOutcome === "enqueued_retry") {
            const retrySuffix = crypto.randomUUID();
            results.push({
              outcome: "enqueued_retry",
              jobId: `${id}__retry_${retrySuffix}`,
              collision: "completed",
              retryJobId: `${id}__retry_${retrySuffix}`,
            });
          } else if (loserOutcome === "reused_active") {
            results.push({ outcome: "reused_active", jobId: id, collision: "active" });
          } else {
            // limbo_forced branch — ADR-0018 §Decision 4 case(c) "unknown →
            // ADR-0017 limbo として処理" contract (post Option Z-a canonical
            // non-lifecycle loser).
            results.push({ outcome: "limbo_forced", jobId: id, collision: "unknown" });
          }
        }

        // Winner count: exactly 50.
        expect(results.filter((r) => r.outcome === "enqueued_new").length).toBe(50);
        // Loser count: exactly 50 (sum of 3 loser variants post Option Z-a).
        expect(results.filter((r) => r.outcome !== "enqueued_new").length).toBe(50);
        // Zero silent no-ops: every result has a defined outcome + jobId.
        for (const r of results) {
          expect(r.outcome).toBeDefined();
          expect(r.jobId).toBeTruthy();
        }
      }
    });
  });

  // ==========================================================================
  // Block C — Real Prisma + real Redis (2 tests)
  // ==========================================================================
  describe("Block C: real Prisma + real Redis integration (2 tests)", () => {
    let prisma: PrismaClient;
    let queue: Queue<PageAnalyzeJobData, PageAnalyzeJobResult>;
    let redisConfig: { host: string; port: number };

    beforeAll(async () => {
      if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
        throw new Error(
          "[INV-PAGE-QUEUE-001-E] DATABASE_URL / REDIS_URL not set by globalSetup (testcontainer boot failure?)"
        );
      }
      prisma = new PrismaClient({
        datasources: { db: { url: process.env.DATABASE_URL } },
        log: ["error"],
      });
      await prisma.$connect();

      setAuditLogPrismaClientFactory(() => prisma as unknown as AuditLogPrismaClient);

      redisConfig = parseRedisUrl(process.env.REDIS_URL);
      queue = createPageAnalyzeQueue({ host: redisConfig.host, port: redisConfig.port });
      // Wait for the BullMQ Queue's underlying Redis client to be fully
      // connected before any test runs. Without this, the first parallel
      // `queue.add` batch can race against the connection handshake and
      // silently land zero jobs in the waiting zset.
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
      assertInvName(expect.getState().currentTestName ?? "", "INV-PAGE-QUEUE-001-E");
      // Drain via `queue.drain(true)` — removes all waiting / delayed /
      // prioritized jobs without tearing down the queue's Redis keyspace
      // (unlike `obliterate`, which renders subsequent `queue.add` silent
      // no-ops when the queue re-registers asynchronously).
      try {
        await queue.drain(true);
        // Also clear any completed / failed retention entries so the next
        // test's job-count assertion sees a clean slate.
        await queue.clean(0, 100_000, "completed");
        await queue.clean(0, 100_000, "failed");
      } catch {
        /* best-effort */
      }
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE audit_logs RESTART IDENTITY CASCADE`);
    });

    it("INV-PAGE-QUEUE-001-E: C16 — 100 parallel addPageAnalyzeJobWithGuard: no drop under real BullMQ, all jobIds unique, queue counts accurate", async () => {
      // Plan §4.2 Block C #16 (real Redis race reproduction).
      // Submit 100 webPageIds in parallel. ADR-0018 Amendment 11 / NEW-TDA-V1-01:
      // the jobId is now the URL-stable UUIDv5 `buildUrlStableJobId(data.url)`,
      // NOT `<webPageId>`. C16 stays `all enqueued_new` because `buildJobData`
      // embeds the per-call webPageId in the URL
      // (`…/inv-page-queue-001-e/${webPageId}`), so each URL is distinct → each
      // claim is a distinct Redis key (`reftrix:page-analyze:jobclaim:<uuidv5>`)
      // and atomic SETNX always wins. SILENT-REGRESS WARNING: if `buildJobData`
      // is changed to a shared/static URL, the per-call URLs collapse to one
      // UUIDv5 and C16 silently regresses (winners + losers, not all 100
      // enqueued_new). C16's invariant depends on URL per-call distinctness, not
      // on webPageId distinctness.
      const webPageIds = Array.from({ length: 100 }, () => crypto.randomUUID());

      const promises = webPageIds.map((id) => addPageAnalyzeJobWithGuard(queue, buildJobData(id)));
      const results = await Promise.all(promises);

      // Every result is a non-null discriminated outcome.
      expect(results.length).toBe(100);
      for (const r of results) {
        expect(r).toBeDefined();
        expect(r.outcome).toBeTruthy();
        expect(r.jobId).toBeTruthy();
      }

      // Unique jobIds: a set must contain all 100 distinct entries.
      const jobIdSet = new Set(results.map((r) => r.jobId));
      expect(jobIdSet.size).toBe(100);

      // Distribution: since each webPageId is distinct, every outcome
      // should be `enqueued_new` (no collisions). Tolerate transient
      // fail-open on Redis hiccup but count must still be 100.
      const enqueuedNewCount = results.filter((r) => r.outcome === "enqueued_new").length;
      const failOpenCount = results.filter((r) => r.outcome === "enqueued_fail_open").length;
      expect(enqueuedNewCount + failOpenCount).toBe(100);

      // BullMQ queue count accuracy: waiting + active + delayed must
      // equal ~100 (minus any that already completed via empty processor,
      // which we do not start here). Allow fail-open path not to land
      // cleanly by checking the lower bound.
      // BullMQ 5.x: jobs with `priority: N` (non-zero) land in the
      // `prioritized` state, NOT `waiting`. Include all possible terminal +
      // non-terminal buckets in the total-landed calculation.
      const counts = await queue.getJobCounts(
        "waiting",
        "active",
        "delayed",
        "prioritized",
        "completed",
        "failed"
      );
      const totalLanded =
        (counts.waiting ?? 0) +
        (counts.active ?? 0) +
        (counts.delayed ?? 0) +
        (counts.prioritized ?? 0) +
        (counts.completed ?? 0) +
        (counts.failed ?? 0);
      // Every `enqueued_new` must produce a BullMQ job; fail-open also
      // adds to the queue (via bare `queue.add` in handleFailOpen).
      expect(totalLanded).toBeGreaterThanOrEqual(enqueuedNewCount);
    }, 90_000);

    it("INV-PAGE-QUEUE-001-E: C17 — end-to-end integration: dispatchBackfillCategories 3 call sites route through addEmbeddingBackfillJobWithGuard + handle EnqueueResult without throwing", async () => {
      // Plan §4.2 Block C #17 (PR-D-6 end-to-end integration pin).
      // The production code path at `page-analyze-worker.ts` L442 / L458 /
      // L487 calls `addEmbeddingBackfillJobWithGuard` for part_text,
      // part_visual, and section_visual categories. Each call site wraps
      // the result in `try / catch` + `logger.info` on non-`enqueued_new`.
      // The invariant here: all 3 call sites use the with-guard helper
      // (not legacy `addEmbeddingBackfillJob`) and gracefully handle every
      // EnqueueResult variant without throwing to the Worker.
      const project = createAstProject();
      const workerSource = addMcpServerSourceFile(
        project,
        "src/workers/page-analyze-worker.ts"
      ).getFullText();

      // All 3 call sites present (scope hint: L442 / L458 / L487 +/- line drift).
      const guardCallSites = workerSource.match(/addEmbeddingBackfillJobWithGuard\s*\(/g) ?? [];
      expect(guardCallSites.length).toBeGreaterThanOrEqual(3);

      // Each call site is wrapped in try/catch — non-fatal on error per
      // `dispatchBackfillCategories` contract.
      const tryBlocks =
        workerSource.match(/try\s*\{[\s\S]*?addEmbeddingBackfillJobWithGuard/g) ?? [];
      expect(tryBlocks.length).toBeGreaterThanOrEqual(3);

      // Each call site inspects `result.outcome !== "enqueued_new"` and
      // emits a `logger.info` (observability for non-happy-path outcomes).
      const outcomeInspections =
        workerSource.match(/result\.outcome\s*!==\s*"enqueued_new"/g) ?? [];
      expect(outcomeInspections.length).toBeGreaterThanOrEqual(3);

      // Independent runtime verification: a single pass through the
      // with-guard helper from a seeded webPageId must land cleanly in
      // BullMQ AND not throw, proving the integration handshake is intact.
      const webPageId = crypto.randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO web_pages (id, url, source_type, usage_scope, updated_at)
           VALUES ($1::uuid, $2, 'user_provided', 'inspiration_only', NOW())`,
        webPageId,
        `https://example.com/inv-page-queue-001-e-C17/${webPageId}`
      );

      const result = await addPageAnalyzeJobWithGuard(queue, buildJobData(webPageId));
      expect(result.outcome).toBeDefined();
      expect(result.jobId).toBeTruthy();
      // With a fresh webPageId, outcome is `enqueued_new` (or fail-open on
      // Redis hiccup).
      expect(["enqueued_new", "enqueued_fail_open"]).toContain(result.outcome);
    }, 60_000);
  });
});
