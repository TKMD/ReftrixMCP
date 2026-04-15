// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Backfill Queue Tests (v0.4.0 PR4)
 *
 * Tests for BullMQ queue configuration, job id uniqueness, and state queries.
 * Redis を必要とする統合テストは isRedisAvailable() で skip 可能。
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  BACKFILL_JOB_ID_SEPARATOR,
  EMBEDDING_BACKFILL_QUEUE_NAME,
  EmbeddingBackfillJobDataSchema,
  createEmbeddingBackfillQueue,
  addEmbeddingBackfillJob,
  getEmbeddingBackfillJobStatus,
  closeEmbeddingBackfillQueue,
  checkEmbeddingBackfillQueueHealth,
  buildBackfillJobId,
  type EmbeddingBackfillJobData,
  type EmbeddingBackfillJobResult,
} from "../../src/queues/embedding-backfill-queue";
import { isRedisAvailable } from "../../src/config/redis";
import type { Queue } from "bullmq";

describe("Embedding Backfill Queue (v0.4.0 PR4)", () => {
  describe("Constants and types", () => {
    it("should have the canonical queue name", () => {
      expect(EMBEDDING_BACKFILL_QUEUE_NAME).toBe("embedding-backfill");
    });

    it("should build deterministic job ids with `__` separator (BullMQ `:` restriction)", () => {
      // BullMQ v5 rejects custom job IDs containing `:` with
      // `Custom Id cannot contain :`. `__` is the safe separator (UUIDv7 and
      // category enum values never contain it).
      // https://docs.bullmq.io/guide/jobs/job-ids
      const id1 = buildBackfillJobId("019bc123-4567-7890-abcd-ef1234567890", "part_text");
      const id2 = buildBackfillJobId("019bc123-4567-7890-abcd-ef1234567890", "part_visual");
      expect(id1).toBe("019bc123-4567-7890-abcd-ef1234567890__part_text");
      expect(id2).toBe("019bc123-4567-7890-abcd-ef1234567890__part_visual");
      expect(id1).not.toBe(id2);
    });

    it("should export `__` as the canonical separator constant", () => {
      expect(BACKFILL_JOB_ID_SEPARATOR).toBe("__");
    });

    it("should never emit `:` in generated job ids (BullMQ compliance)", () => {
      // Assert the invariant for every SSOT category.
      const categories = [
        "part_text",
        "part_visual",
        "section_visual",
        "motion",
        "background",
        "js_animation",
        "responsive",
      ] as const;
      for (const category of categories) {
        const id = buildBackfillJobId("019bc123-4567-7890-abcd-ef1234567890", category);
        expect(id).not.toContain(":");
        expect(id).toMatch(/^[0-9a-f-]{36}__[a-z_]+$/);
      }
    });

    it("should round-trip webPageId and category via the separator", () => {
      const webPageId = "019bc123-4567-7890-abcd-ef1234567890";
      const id = buildBackfillJobId(webPageId, "part_text");
      const [extractedId, extractedCategory] = id.split(BACKFILL_JOB_ID_SEPARATOR);
      expect(extractedId).toBe(webPageId);
      expect(extractedCategory).toBe("part_text");
    });

    it("should accept minimal job data shape", () => {
      const data: EmbeddingBackfillJobData = {
        webPageId: "019bc123-4567-7890-abcd-ef1234567890",
        category: "part_text",
        createdAt: new Date().toISOString(),
      };
      expect(data.webPageId).toBeDefined();
      expect(data.category).toBe("part_text");
    });

    it("should accept visual job data with screenshot path", () => {
      const data: EmbeddingBackfillJobData = {
        webPageId: "019bc123-4567-7890-abcd-ef1234567890",
        category: "part_visual",
        screenshotStoragePath: "/data/phase5-screenshots/019bc123.png",
        requiresBboxResolution: true,
        createdAt: new Date().toISOString(),
      };
      expect(data.screenshotStoragePath).toBeDefined();
      expect(data.requiresBboxResolution).toBe(true);
    });
  });

  describe("Queue operations (requires Redis)", () => {
    let queue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult> | null = null;
    let redisAvailable = false;

    beforeAll(async () => {
      redisAvailable = await isRedisAvailable();
    });

    beforeEach(async () => {
      if (redisAvailable) {
        queue = createEmbeddingBackfillQueue();
      }
    });

    afterEach(async () => {
      if (queue) {
        await queue.obliterate({ force: true });
        await closeEmbeddingBackfillQueue(queue);
        queue = null;
      }
    });

    it.skipIf(!redisAvailable)("should add a part_text backfill job", async () => {
      if (!queue) return;

      const job = await addEmbeddingBackfillJob(queue, {
        webPageId: "019bc123-4567-7890-abcd-ef1234567890",
        category: "part_text",
      });

      expect(job).toBeDefined();
      expect(job.id).toBe("019bc123-4567-7890-abcd-ef1234567890__part_text");
      expect(job.data.category).toBe("part_text");
      expect(job.data.createdAt).toBeDefined();
    });

    it.skipIf(!redisAvailable)("should add a part_visual backfill job", async () => {
      if (!queue) return;

      const job = await addEmbeddingBackfillJob(queue, {
        webPageId: "019bc123-4567-7890-abcd-ef1234567891",
        category: "part_visual",
        screenshotStoragePath: "/tmp/test.png",
        requiresBboxResolution: true,
      });

      expect(job.id).toBe("019bc123-4567-7890-abcd-ef1234567891__part_visual");
      expect(job.data.screenshotStoragePath).toBe("/tmp/test.png");
    });

    it.skipIf(!redisAvailable)(
      "should deduplicate identical webPageId + category (jobId uniqueness)",
      async () => {
        if (!queue) return;

        const webPageId = "019bc123-4567-7890-abcd-ef1234567892";
        // 1回目の投入
        const first = await addEmbeddingBackfillJob(queue, {
          webPageId,
          category: "part_text",
        });
        // 2回目は同一 jobId のため既存ジョブを返す（BullMQ の冪等性）
        const second = await addEmbeddingBackfillJob(queue, {
          webPageId,
          category: "part_text",
        });

        expect(first.id).toBe(second.id);
        // BullMQ は同一 jobId の場合、既存ジョブの data を保持する
        expect(first.data.createdAt).toBe(second.data.createdAt);
      }
    );

    it.skipIf(!redisAvailable)(
      "should allow different categories for the same webPageId",
      async () => {
        if (!queue) return;

        const webPageId = "019bc123-4567-7890-abcd-ef1234567893";
        const textJob = await addEmbeddingBackfillJob(queue, { webPageId, category: "part_text" });
        const visualJob = await addEmbeddingBackfillJob(queue, {
          webPageId,
          category: "part_visual",
          screenshotStoragePath: "/tmp/test.png",
        });

        expect(textJob.id).not.toBe(visualJob.id);
        expect(textJob.id).toContain("__part_text");
        expect(visualJob.id).toContain("__part_visual");
        // Explicitly assert BullMQ `:` restriction compliance
        expect(textJob.id).not.toContain(":");
        expect(visualJob.id).not.toContain(":");
      }
    );

    it.skipIf(!redisAvailable)("should get job status by id", async () => {
      if (!queue) return;

      const webPageId = "019bc123-4567-7890-abcd-ef1234567894";
      await addEmbeddingBackfillJob(queue, { webPageId, category: "part_text" });

      const jobId = buildBackfillJobId(webPageId, "part_text");
      const status = await getEmbeddingBackfillJobStatus(queue, jobId);

      expect(status).not.toBeNull();
      expect(status?.jobId).toBe(jobId);
      expect(status?.state).toBe("waiting");
      expect(status?.progress).toBe(0);
    });

    it.skipIf(!redisAvailable)("should return null for a non-existent job", async () => {
      if (!queue) return;
      const status = await getEmbeddingBackfillJobStatus(queue, "non-existent-job-id");
      expect(status).toBeNull();
    });

    it.skipIf(!redisAvailable)("should report queue health", async () => {
      if (!queue) return;

      const health = await checkEmbeddingBackfillQueueHealth(queue);

      expect(health.healthy).toBe(true);
      expect(typeof health.stats.waiting).toBe("number");
      expect(typeof health.stats.active).toBe("number");
      expect(typeof health.stats.completed).toBe("number");
      expect(typeof health.stats.failed).toBe("number");
      expect(typeof health.stats.delayed).toBe("number");
    });

    it.skipIf(!redisAvailable)("should configure attempts=3 and exponential backoff", async () => {
      if (!queue) return;

      const job = await addEmbeddingBackfillJob(queue, {
        webPageId: "019bc123-4567-7890-abcd-ef1234567895",
        category: "part_text",
      });

      // Default options inherited from queue creation
      expect(job.opts.attempts).toBe(3);
      expect(job.opts.backoff).toEqual({
        type: "exponential",
        delay: 5000,
        // PR7b-convergence (SEC MEDIUM-1): ±50% jitter for Thundering Herd defense
        jitter: 0.5,
      });
    });
  });

  // =====================================================
  // Zod validation (SEC M-1 / v0.4.0 PR4 audit)
  // =====================================================
  describe("Zod job data validation (SEC M-1)", () => {
    const validBase = {
      webPageId: "019bc123-4567-7890-abcd-ef1234567890",
      category: "part_text" as const,
      createdAt: "2026-04-12T00:00:00.000Z",
    };

    it("should accept a valid minimal job data shape", () => {
      expect(() => EmbeddingBackfillJobDataSchema.parse(validBase)).not.toThrow();
    });

    it("should accept a valid visual job data with screenshot path", () => {
      const result = EmbeddingBackfillJobDataSchema.safeParse({
        ...validBase,
        category: "part_visual",
        screenshotStoragePath: "/tmp/reftrix-screenshots/phase5/019bc123.png",
        requiresBboxResolution: true,
      });
      expect(result.success).toBe(true);
    });

    it("should reject invalid UUID format", () => {
      const result = EmbeddingBackfillJobDataSchema.safeParse({
        ...validBase,
        webPageId: "not-a-uuid",
      });
      expect(result.success).toBe(false);
    });

    it("should reject UUID with newline injection", () => {
      const result = EmbeddingBackfillJobDataSchema.safeParse({
        ...validBase,
        webPageId: "019bc123-4567-7890-abcd-ef1234567890\npart_visual",
      });
      expect(result.success).toBe(false);
    });

    it("should reject invalid category enum", () => {
      // v0.4.0 PR7a-2: SSOT を 7 カテゴリに拡張。`section_visual` は valid になったので
      // 完全に未知のカテゴリ名で reject を検証する。
      // v0.4.0 PR7a-2: SSOT expanded to 7 categories — `section_visual` is now valid,
      // so we probe with a definitely-unknown category name.
      const result = EmbeddingBackfillJobDataSchema.safeParse({
        ...validBase,
        category: "totally_unknown_category",
      });
      expect(result.success).toBe(false);
    });

    it("should accept all 7 SSOT categories (PR7a-2)", () => {
      for (const category of [
        "part_text",
        "part_visual",
        "section_visual",
        "motion",
        "background",
        "js_animation",
        "responsive",
      ] as const) {
        const result = EmbeddingBackfillJobDataSchema.safeParse({ ...validBase, category });
        expect(result.success, `category=${category} should be valid`).toBe(true);
      }
    });

    it("should reject screenshotStoragePath over 512 chars (DoS defense)", () => {
      const longPath = "/tmp/" + "a".repeat(600);
      const result = EmbeddingBackfillJobDataSchema.safeParse({
        ...validBase,
        screenshotStoragePath: longPath,
      });
      expect(result.success).toBe(false);
    });

    it("should reject missing createdAt", () => {
      const { createdAt: _cat, ...withoutCreatedAt } = validBase;
      const result = EmbeddingBackfillJobDataSchema.safeParse(withoutCreatedAt);
      expect(result.success).toBe(false);
    });

    it("should reject non-boolean requiresBboxResolution", () => {
      const result = EmbeddingBackfillJobDataSchema.safeParse({
        ...validBase,
        requiresBboxResolution: "yes",
      });
      expect(result.success).toBe(false);
    });

    it("should reject requestId over 128 chars", () => {
      const result = EmbeddingBackfillJobDataSchema.safeParse({
        ...validBase,
        requestId: "x".repeat(200),
      });
      expect(result.success).toBe(false);
    });

    it("should allow omitting optional fields", () => {
      const result = EmbeddingBackfillJobDataSchema.safeParse(validBase);
      expect(result.success).toBe(true);
    });
  });

  // =====================================================
  // addEmbeddingBackfillJob enforces validation (without Redis)
  // =====================================================
  describe("addEmbeddingBackfillJob validation at enqueue boundary", () => {
    it("should throw on invalid UUID without calling Redis", async () => {
      // Pass a minimal stub queue — validation should fail before `queue.add` is invoked.
      const stubQueue = {
        add: async () => {
          throw new Error("Redis should not be called when validation fails");
        },
      } as unknown as Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;

      await expect(
        addEmbeddingBackfillJob(stubQueue, {
          webPageId: "not-a-uuid",
          category: "part_text",
        })
      ).rejects.toThrow(/Invalid job data/);
    });

    it("should throw on invalid category without calling Redis", async () => {
      const stubQueue = {
        add: async () => {
          throw new Error("Redis should not be called when validation fails");
        },
      } as unknown as Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;

      await expect(
        addEmbeddingBackfillJob(stubQueue, {
          webPageId: "019bc123-4567-7890-abcd-ef1234567890",
          // @ts-expect-error — intentionally invalid to exercise Zod enforcement
          // v0.4.0 PR7a-2: `section_visual` は SSOT に含まれるため、unknown で検証する
          // v0.4.0 PR7a-2: `section_visual` is part of the SSOT now; use a truly unknown value
          category: "definitely_not_a_category",
        })
      ).rejects.toThrow(/Invalid job data/);
    });

    it("should throw on oversized screenshotStoragePath without calling Redis", async () => {
      const stubQueue = {
        add: async () => {
          throw new Error("Redis should not be called when validation fails");
        },
      } as unknown as Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;

      await expect(
        addEmbeddingBackfillJob(stubQueue, {
          webPageId: "019bc123-4567-7890-abcd-ef1234567890",
          category: "part_visual",
          screenshotStoragePath: "/tmp/" + "a".repeat(600),
        })
      ).rejects.toThrow(/Invalid job data/);
    });
  });
});
