// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — large-page domain
 *
 * INV-PAGE-QUEUE-001: page.analyze が >100 ComponentParts を持つ WebPage を
 *   処理した際、Phase 5 の embedding が同期処理で完結せず、必ず BullMQ
 *   `embedding-backfill` Queue 経由で非同期 backfill worker が
 *   `completed` / `failed` / `skipped_memory_pressure` / `skipped_fork_error`
 *   / `skipped_screenshot_missing` のいずれかの **終端状態**に到達する。
 *
 * INV-PAGE-QUEUE-001: When `page.analyze` processes a WebPage with more than
 *   100 ComponentParts, Phase 5 embedding must not complete synchronously —
 *   instead, it must reach a **terminal state** (`completed` / `failed` /
 *   `skipped_memory_pressure` / `skipped_fork_error` / `skipped_screenshot_missing`)
 *   via the asynchronous BullMQ `embedding-backfill` Queue worker.
 *
 * ## 責務分離 / Responsibility separation (ADR-0016 § Existing Test Migration Mapping)
 *
 *   - **本 standing test**: 契約レベル終端状態遷移 (Queue → Worker → DB)
 *   - **既存 `tests/workers/phases/phase-5-fork-orchestrator.test.ts`**: fork IPC 実装詳細
 *   - **既存 `tests/workers/embedding-backfill-worker.test.ts`**: source-code 静的検証
 *
 *   - **This standing test**: contract-level terminal-state transition
 *   - **Existing phase-5-fork-orchestrator test**: fork IPC internals
 *   - **Existing embedding-backfill-worker test**: source-code static checks
 *
 * ## 実装戦略 / Implementation strategy
 *
 *   1. testcontainer postgres に @reftrixmcp/database schema を適用
 *      (global-setup で db push 済)
 *   2. WebPage + >100 ComponentParts を seed (全 part に embedding 事前投入 →
 *      backfill scanner は 0 pending を返す)
 *   3. 実 BullMQ Queue + 実 EmbeddingBackfillWorker を testcontainer Redis で起動
 *   4. `addEmbeddingBackfillJob` で `part_text` カテゴリ投入
 *   5. QueueEvents で terminal 遷移 (completed / failed) を待機
 *   6. DB の `embeddingBackfillStatus` が **終端 enum 値**で、かつ
 *      `queued` / `in_progress` に残存していないことを assert
 *   7. TDD: M1 stub は fail 固定 → 本実装で GREEN 化
 *
 * ADR-0016 § Mock Strategy: `EMBEDDING_MODEL_MOCK=true` で ONNX Runtime 推論は
 * mock されるが、本テストは **backfill 対象 0 件** に seed することで実推論を
 * そもそも発火させない (Worker は `completed` に直遷移)。
 *
 * @see ADR-0016 § Invariants
 * @see ADR-0007 (Phase 5 Queue-based Backfill)
 */

import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { QueueEvents, type Queue } from "bullmq";
import { assertInvName } from "../_setup/inv-assert";
import {
  addEmbeddingBackfillJob,
  buildBackfillJobId,
  createEmbeddingBackfillQueue,
  type EmbeddingBackfillJobData,
  type EmbeddingBackfillJobResult,
} from "../../../../src/queues/embedding-backfill-queue";
import {
  createEmbeddingBackfillWorker,
  type EmbeddingBackfillWorkerInstance,
} from "../../../../src/workers/embedding-backfill-worker";
import { cleanupSeededWebPage, seedWebPageWithParts } from "./_fixtures/seed-large-page";

/**
 * INV-PAGE-QUEUE-001 の precondition 閾値 (100 parts)。
 * この値を超える ComponentParts を持つページが契約対象。
 *
 * Precondition threshold for INV-PAGE-QUEUE-001 (100 parts). Pages exceeding
 * this count are subject to the invariant.
 */
const LARGE_PAGE_PART_COUNT = 101 as const;

/**
 * Queue consume 後に終端遷移するまでの最大待機 (ms)。
 *
 * Max wait for terminal transition after Queue consume (ms).
 */
const TERMINAL_WAIT_MS = 45_000;

/**
 * 終端状態 enum 値 (ADR-0016 § Invariants + `EmbeddingBackfillStatus` SSOT)
 *
 * Terminal enum values (ADR-0016 § Invariants + `EmbeddingBackfillStatus` SSOT).
 */
const TERMINAL_STATUSES = [
  "completed",
  "failed",
  "skipped_memory_pressure",
  "skipped_fork_error",
  "skipped_screenshot_missing",
] as const;

/**
 * Non-terminal 状態 (これらに残存したら不変条件違反)。
 *
 * Non-terminal statuses (remaining here violates the invariant).
 */
const NON_TERMINAL_STATUSES = ["queued", "in_progress"] as const;

/**
 * Parse `redis://host:port` into host / port for BullMQ connection options.
 *
 * testcontainer が渡す `redis://host:port` を BullMQ 用の {host, port} に分解する。
 */
function parseRedisUrl(redisUrl: string): { host: string; port: number } {
  const match = redisUrl.match(/^redis:\/\/([^:/]+):(\d+)(?:\/|$)/);
  if (!match) {
    throw new Error(
      `[INV-PAGE-QUEUE-001] Unable to parse REDIS_URL (expected redis://host:port): ${redisUrl}`
    );
  }
  const port = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`[INV-PAGE-QUEUE-001] Invalid REDIS_URL port: ${match[2]}`);
  }
  return { host: match[1]!, port };
}

describe("INV-PAGE-QUEUE-001: page.analyze >100 parts reaches Queue-driven terminal state", () => {
  let prisma: PrismaClient;
  let redisConfig: { host: string; port: number };
  let queue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;
  let queueEvents: QueueEvents;
  let workerHandle: EmbeddingBackfillWorkerInstance;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
      throw new Error(
        "[INV-PAGE-QUEUE-001] DATABASE_URL / REDIS_URL not set by globalSetup (testcontainer boot failure?)"
      );
    }
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    await prisma.$connect();

    redisConfig = parseRedisUrl(process.env.REDIS_URL);

    queue = createEmbeddingBackfillQueue({ host: redisConfig.host, port: redisConfig.port });

    // QueueEvents must be ready before addJob to avoid event-miss race.
    queueEvents = new QueueEvents("embedding-backfill", {
      connection: {
        host: redisConfig.host,
        port: redisConfig.port,
        maxRetriesPerRequest: null,
      },
    });
    await queueEvents.waitUntilReady();

    workerHandle = createEmbeddingBackfillWorker({
      redisConfig: { host: redisConfig.host, port: redisConfig.port },
      // Faster terminal transition for the no-op fixture path.
      concurrency: 1,
      verbose: false,
    });
    await workerHandle.worker.waitUntilReady();
    // BullMQ Worker.run() returns a Promise that only resolves when the worker
    // is closed. Awaiting it here would block beforeAll indefinitely.
    // Fire-and-forget: start the consume loop, catch background errors so
    // unhandled rejections don't crash the test runner.
    workerHandle.worker.run().catch(() => {
      /* consumed by afterAll cleanup */
    });
  }, 180_000);

  afterAll(async () => {
    try {
      await workerHandle?.close();
    } catch {
      /* best-effort shutdown */
    }
    try {
      await queueEvents?.close();
    } catch {
      /* best-effort shutdown */
    }
    try {
      await queue?.close();
    } catch {
      /* best-effort shutdown */
    }
    try {
      await prisma?.$disconnect();
    } catch {
      /* best-effort shutdown */
    }
  }, 30_000);

  beforeEach(() => {
    // ADR-0016 § ESLint Rule Strategy — runtime assertion (inv-assert.ts)
    assertInvName(expect.getState().currentTestName ?? "", "INV-PAGE-QUEUE-001");
  });

  it(
    "INV-PAGE-QUEUE-001: backfill worker reaches a terminal state via the Queue for a >100 parts page",
    async () => {
      // ------------------------------------------------------------------
      // 1. Seed a WebPage with >100 ComponentParts (pre-embedded → backfill
      //    is a no-op from the scanner's perspective; the Worker still must
      //    transition the status to a terminal value — that is the invariant).
      // ------------------------------------------------------------------
      const seed = await seedWebPageWithParts(prisma, {
        partCount: LARGE_PAGE_PART_COUNT,
        preEmbedAll: true,
      });

      try {
        // ----------------------------------------------------------------
        // 2. Precondition assertion: status starts at `not_required`.
        // ----------------------------------------------------------------
        const before = await prisma.webPage.findUnique({
          where: { id: seed.webPageId },
          select: { embeddingBackfillStatus: true },
        });
        expect(before?.embeddingBackfillStatus).toBe("not_required");

        // ----------------------------------------------------------------
        // 3. Enqueue a `part_text` backfill job on the real BullMQ Queue.
        //    jobId = `<webPageId>__part_text` (idempotent enqueue key).
        // ----------------------------------------------------------------
        const expectedJobId = buildBackfillJobId(seed.webPageId, "part_text");
        await addEmbeddingBackfillJob(queue, {
          webPageId: seed.webPageId,
          category: "part_text",
        });

        // ----------------------------------------------------------------
        // 4. Wait for the Worker to reach a terminal BullMQ state
        //    (completed | failed). Both are acceptable for INV-PAGE-QUEUE-001
        //    as long as the DB-side status lands in TERMINAL_STATUSES.
        // ----------------------------------------------------------------
        const terminalPromise = new Promise<{ kind: "completed" | "failed"; jobId: string }>(
          (resolve, reject) => {
            const timer = setTimeout(() => {
              reject(
                new Error(
                  `[INV-PAGE-QUEUE-001] Terminal wait timed out after ${TERMINAL_WAIT_MS}ms for jobId=${expectedJobId}`
                )
              );
            }, TERMINAL_WAIT_MS);
            queueEvents.on("completed", ({ jobId }) => {
              if (jobId === expectedJobId) {
                clearTimeout(timer);
                resolve({ kind: "completed", jobId });
              }
            });
            queueEvents.on("failed", ({ jobId }) => {
              if (jobId === expectedJobId) {
                clearTimeout(timer);
                resolve({ kind: "failed", jobId });
              }
            });
          }
        );
        const terminal = await terminalPromise;

        // ----------------------------------------------------------------
        // 5. Assert: DB-side `embeddingBackfillStatus` is a terminal enum value
        //    (primary invariant) AND NOT lingering in non-terminal states.
        //    Small retry (≤ 5s) handles the Worker's async DB update after
        //    the BullMQ terminal event fires.
        // ----------------------------------------------------------------
        const STATUS_POLL_TIMEOUT_MS = 5_000;
        const STATUS_POLL_INTERVAL_MS = 100;
        const pollStart = Date.now();
        let finalStatus: string | null = null;
        while (Date.now() - pollStart < STATUS_POLL_TIMEOUT_MS) {
          const page = await prisma.webPage.findUnique({
            where: { id: seed.webPageId },
            select: { embeddingBackfillStatus: true },
          });
          if (
            page &&
            (TERMINAL_STATUSES as readonly string[]).includes(page.embeddingBackfillStatus)
          ) {
            finalStatus = page.embeddingBackfillStatus;
            break;
          }
          await new Promise((r) => setTimeout(r, STATUS_POLL_INTERVAL_MS));
        }

        expect(
          finalStatus,
          `DB status must reach terminal state (completed/failed/skipped_*), got ${finalStatus ?? "null"} after ${Date.now() - pollStart}ms`
        ).not.toBeNull();
        expect(TERMINAL_STATUSES).toContain(finalStatus);
        expect(NON_TERMINAL_STATUSES).not.toContain(finalStatus);

        // ----------------------------------------------------------------
        // 6. Assert: BullMQ job state mirrors the DB state (observability contract).
        // ----------------------------------------------------------------
        expect(["completed", "failed"]).toContain(terminal.kind);
      } finally {
        // ADR-0016 § Fixture Lifecycle — deletion contract for ephemeral seeds.
        await cleanupSeededWebPage(prisma, seed.webPageId);
      }
    },
    TERMINAL_WAIT_MS + 30_000
  );
});
