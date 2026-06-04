// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Page Analyze Queue Tests
 *
 * Tests for BullMQ queue configuration and operations
 * Note: Some tests are skipped when Redis is not available
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { z } from "zod";
import { validate as uuidValidate, version as uuidVersion } from "uuid";
import {
  PAGE_ANALYZE_QUEUE_NAME,
  createPageAnalyzeQueue,
  createQueueEvents,
  addPageAnalyzeJobWithGuard,
  buildUrlStableJobId,
  getJobStatus,
  closeQueue,
  checkQueueHealth,
  extractCurrentPhase,
  type PageAnalyzeJobData,
  type PageAnalyzeJobResult,
  type PageAnalyzeJobOptions,
} from "../../src/queues/page-analyze-queue";
import { isRedisAvailable } from "../../src/config/redis";
import type { Queue } from "bullmq";

describe("Page Analyze Queue", () => {
  describe("Constants and Types", () => {
    it("should have correct queue name", () => {
      expect(PAGE_ANALYZE_QUEUE_NAME).toBe("page-analyze");
    });
  });

  // ADR-0018 Amendment 11 (PR-SAMEURL-DEDUP, Strategy A): URL-stable UUIDv5 jobId.
  describe("buildUrlStableJobId (URL-stable UUIDv5 jobId)", () => {
    it("is deterministic: same URL → same UUIDv5", () => {
      const a = buildUrlStableJobId("https://example.com/page");
      const b = buildUrlStableJobId("https://example.com/page");
      expect(a).toBe(b);
    });

    it("distinct URLs → distinct UUIDv5", () => {
      const a = buildUrlStableJobId("https://example.com/a");
      const b = buildUrlStableJobId("https://example.com/b");
      expect(a).not.toBe(b);
    });

    it("returns a valid RFC 4122 v5 UUID", () => {
      const id = buildUrlStableJobId("https://example.com/page");
      expect(uuidValidate(id)).toBe(true);
      expect(uuidVersion(id)).toBe(5);
    });

    it("passes z.string().uuid() (SEC-RV1-H-01 closure: schema gate accepts the jobId)", () => {
      const id = buildUrlStableJobId("https://example.com/page");
      expect(z.string().uuid().safeParse(id).success).toBe(true);
    });

    it("normalization: fragment-insensitive, query-sensitive (matches normalizeUrlForValidation)", () => {
      // Fragment is stripped → same UUIDv5.
      expect(buildUrlStableJobId("https://x.com/p")).toBe(
        buildUrlStableJobId("https://x.com/p#frag")
      );
      // Query is kept (sorted) → distinct UUIDv5.
      expect(buildUrlStableJobId("https://x.com/p?v=1")).not.toBe(
        buildUrlStableJobId("https://x.com/p?v=2")
      );
    });

    it("matches the canonical node-verified value for https://example.com/p", () => {
      // IO ground-truth value pinned in ADR-0018 Amendment 11 §Decision.
      expect(buildUrlStableJobId("https://example.com/p")).toBe(
        "7986ac7b-c3d8-561b-a6de-158e3866139a"
      );
    });
  });

  describe("PageAnalyzeJobData interface", () => {
    it("should accept valid job data structure", () => {
      const jobData: PageAnalyzeJobData = {
        webPageId: "019bc123-4567-7890-abcd-ef1234567890",
        url: "https://example.com",
        options: {
          timeout: 60000,
          features: {
            layout: true,
            motion: true,
            quality: true,
          },
        },
        createdAt: new Date().toISOString(),
      };

      expect(jobData.webPageId).toBeDefined();
      expect(jobData.url).toBeDefined();
      expect(jobData.options).toBeDefined();
      expect(jobData.createdAt).toBeDefined();
    });

    it("should accept optional requestId", () => {
      const jobData: PageAnalyzeJobData = {
        webPageId: "019bc123-4567-7890-abcd-ef1234567890",
        url: "https://example.com",
        options: {},
        createdAt: new Date().toISOString(),
        requestId: "req-12345",
      };

      expect(jobData.requestId).toBe("req-12345");
    });

    it("should accept minimal options", () => {
      const jobData: PageAnalyzeJobData = {
        webPageId: "019bc123-4567-7890-abcd-ef1234567890",
        url: "https://example.com",
        options: {},
        createdAt: new Date().toISOString(),
      };

      expect(jobData.options).toEqual({});
    });
  });

  describe("PageAnalyzeJobOptions interface", () => {
    it("should accept full options structure", () => {
      const options: PageAnalyzeJobOptions = {
        timeout: 120000,
        features: {
          layout: true,
          motion: false,
          quality: true,
        },
        layoutOptions: {
          useVision: true,
          saveToDb: true,
          autoAnalyze: true,
          fullPage: true,
          viewport: { width: 1920, height: 1080 },
        },
        motionOptions: {
          detectJsAnimations: true,
          enableFrameCapture: true,
          saveToDb: true,
          maxPatterns: 100,
        },
        qualityOptions: {
          strict: true,
          weights: {
            originality: 0.35,
            craftsmanship: 0.4,
            contextuality: 0.25,
          },
          targetIndustry: "technology",
          targetAudience: "enterprise",
        },
      };

      expect(options.timeout).toBe(120000);
      expect(options.features?.layout).toBe(true);
      expect(options.layoutOptions?.useVision).toBe(true);
      expect(options.motionOptions?.detectJsAnimations).toBe(true);
      expect(options.qualityOptions?.weights?.originality).toBe(0.35);
    });
  });

  describe("PageAnalyzeJobResult interface", () => {
    it("should accept success result structure", () => {
      const result: PageAnalyzeJobResult = {
        webPageId: "019bc123-4567-7890-abcd-ef1234567890",
        success: true,
        partialSuccess: false,
        completedPhases: ["ingest", "layout", "motion", "quality"],
        failedPhases: [],
        results: {
          layout: {
            sectionsDetected: 5,
            visionUsed: true,
          },
          motion: {
            patternsDetected: 10,
            jsAnimationsDetected: 3,
          },
          quality: {
            overallScore: 85,
            grade: "A",
          },
        },
        processingTimeMs: 15000,
        completedAt: new Date().toISOString(),
      };

      expect(result.success).toBe(true);
      expect(result.completedPhases).toHaveLength(4);
      expect(result.results?.layout?.sectionsDetected).toBe(5);
    });

    it("should accept failure result structure", () => {
      const result: PageAnalyzeJobResult = {
        webPageId: "019bc123-4567-7890-abcd-ef1234567890",
        success: false,
        partialSuccess: true,
        completedPhases: ["ingest", "layout"],
        failedPhases: ["motion", "quality"],
        error: "Timeout during motion detection",
        processingTimeMs: 60000,
      };

      expect(result.success).toBe(false);
      expect(result.partialSuccess).toBe(true);
      expect(result.error).toBeDefined();
    });
  });

  describe("createPageAnalyzeQueue", () => {
    let queue: Queue<PageAnalyzeJobData, PageAnalyzeJobResult> | null = null;

    afterEach(async () => {
      if (queue) {
        await queue.close();
        queue = null;
      }
    });

    it("should create a queue with correct name", () => {
      queue = createPageAnalyzeQueue();

      expect(queue.name).toBe(PAGE_ANALYZE_QUEUE_NAME);
    });

    it("should create a queue with default job options", () => {
      queue = createPageAnalyzeQueue();

      // Check that queue was created (defaultJobOptions are internal)
      expect(queue).toBeDefined();
      expect(queue.name).toBe("page-analyze");
    });

    it("should accept custom Redis config", () => {
      queue = createPageAnalyzeQueue({
        host: "custom-host",
        port: 12345,
      });

      expect(queue).toBeDefined();
    });
  });

  describe("createQueueEvents", () => {
    it("should create queue events instance", async () => {
      // Redisが利用可能かチェック
      const redisAvailable = await isRedisAvailable();
      if (!redisAvailable) {
        // Redisが利用できない場合はスキップ
        console.log("Skipping test: Redis not available");
        return;
      }

      const events = createQueueEvents();

      expect(events).toBeDefined();

      // Cleanup - use close with force option
      await events.close();
    }, 10000); // 10秒タイムアウト

    it("should accept custom Redis config (creation only)", () => {
      // Note: We only test creation, not connection, to avoid timeout issues
      // with invalid hostnames. The QueueEvents object will try to connect
      // but we don't wait for it.
      const events = createQueueEvents({
        host: "127.0.0.1", // Use localhost to avoid DNS lookup issues
        port: 12345, // Invalid port, but won't cause DNS issues
      });

      expect(events).toBeDefined();

      // Cleanup - don't await as it may hang with invalid config
      events.close().catch(() => {
        /* expected */
      });
    });
  });

  // Integration tests that require Redis
  describe("Queue Operations (requires Redis)", () => {
    let queue: Queue<PageAnalyzeJobData, PageAnalyzeJobResult> | null = null;
    let redisAvailable = false;

    beforeAll(async () => {
      redisAvailable = await isRedisAvailable();
    });

    beforeEach(async () => {
      if (redisAvailable) {
        queue = createPageAnalyzeQueue();
      }
    });

    afterEach(async () => {
      if (queue) {
        // Clean up test jobs
        await queue.obliterate({ force: true });
        await queue.close();
        queue = null;
      }
    });

    it.skipIf(!redisAvailable)("should add a job to the queue", async () => {
      if (!queue) return;

      const url = "https://example.com";
      const result = await addPageAnalyzeJobWithGuard(queue, {
        webPageId: "019bc123-4567-7890-abcd-ef1234567890",
        url,
        options: {
          timeout: 60000,
          features: {
            layout: true,
            motion: true,
            quality: true,
          },
        },
      });

      // WithGuard returns a discriminated `EnqueueResult` whose jobId is the
      // URL-stable UUIDv5 (ADR-0018 Amendment 11), NOT the webPageId.
      expect(result.outcome).toBe("enqueued_new");
      expect(result.jobId).toBe(buildUrlStableJobId(url));

      // Retrieve the enqueued job via the URL-stable jobId for payload assertions.
      const job = await queue.getJob(result.jobId);
      expect(job).toBeDefined();
      expect(job?.data.url).toBe(url);
      expect(job?.data.createdAt).toBeDefined();
    });

    it.skipIf(!redisAvailable)("should add a job with priority", async () => {
      if (!queue) return;

      const url = "https://example.com/priority";
      const result = await addPageAnalyzeJobWithGuard(
        queue,
        {
          webPageId: "019bc123-4567-7890-abcd-ef1234567891",
          url,
          options: {},
        },
        5 // Higher priority (lower number)
      );

      // EnqueueResult has no `.opts`; retrieve the job to assert priority.
      const job = await queue.getJob(result.jobId);
      expect(job).toBeDefined();
      expect(job?.opts.priority).toBe(5);
    });

    it.skipIf(!redisAvailable)("should get job status", async () => {
      if (!queue) return;

      const webPageId = "019bc123-4567-7890-abcd-ef1234567892";

      // WithGuard's jobId is the URL-stable UUIDv5 (≠ webPageId), so status
      // lookup must use `result.jobId`, not the webPageId.
      const result = await addPageAnalyzeJobWithGuard(queue, {
        webPageId,
        url: "https://example.com/status",
        options: {},
      });

      const status = await getJobStatus(queue, result.jobId);

      expect(status).not.toBeNull();
      expect(status?.jobId).toBe(result.jobId);
      expect(status?.state).toBe("waiting");
      expect(status?.progress).toBe(0);
    });

    it.skipIf(!redisAvailable)("should return null for non-existent job", async () => {
      if (!queue) return;

      const status = await getJobStatus(queue, "non-existent-job-id");

      expect(status).toBeNull();
    });

    it.skipIf(!redisAvailable)("should check queue health", async () => {
      if (!queue) return;

      const health = await checkQueueHealth(queue);

      expect(health.healthy).toBe(true);
      expect(health.stats).toBeDefined();
      expect(typeof health.stats.waiting).toBe("number");
      expect(typeof health.stats.active).toBe("number");
      expect(typeof health.stats.completed).toBe("number");
      expect(typeof health.stats.failed).toBe("number");
      expect(typeof health.stats.delayed).toBe("number");
    });

    it.skipIf(!redisAvailable)("should serialize/deserialize job data correctly", async () => {
      if (!queue) return;

      const originalData = {
        webPageId: "019bc123-4567-7890-abcd-ef1234567893",
        url: "https://example.com/serialization",
        options: {
          timeout: 120000,
          features: {
            layout: true,
            motion: false,
            quality: true,
          },
          layoutOptions: {
            viewport: { width: 1920, height: 1080 },
          },
        },
        requestId: "test-request-123",
      };

      const result = await addPageAnalyzeJobWithGuard(queue, originalData);

      // `addPageAnalyzeJobWithGuard` derives the BullMQ jobId from the URL via
      // `buildUrlStableJobId(url)` (a UUIDv5, ADR-0018 Amendment 11), NOT the
      // webPageId. So the returned jobId must equal the URL-stable UUIDv5.
      expect(result.jobId).toBe(buildUrlStableJobId(originalData.url));

      // Retrieve the job by that same URL-stable jobId
      const retrievedJob = await queue.getJob(result.jobId);

      expect(retrievedJob).not.toBeNull();
      expect(retrievedJob?.data.url).toBe(originalData.url);
      expect(retrievedJob?.data.options.timeout).toBe(120000);
      expect(retrievedJob?.data.options.features?.motion).toBe(false);
      expect(retrievedJob?.data.options.layoutOptions?.viewport?.width).toBe(1920);
      expect(retrievedJob?.data.requestId).toBe("test-request-123");
    });

    it.skipIf(!redisAvailable)("should handle multiple jobs", async () => {
      if (!queue) return;

      // 3 distinct URLs → 3 distinct URL-stable UUIDv5 jobIds → all enqueued_new
      // (same-URL would dedup to `reused_active` and break the waiting>=3 count).
      const results = await Promise.all([
        addPageAnalyzeJobWithGuard(queue, {
          webPageId: "019bc123-4567-7890-abcd-ef1234567894",
          url: "https://example.com/page1",
          options: {},
        }),
        addPageAnalyzeJobWithGuard(queue, {
          webPageId: "019bc123-4567-7890-abcd-ef1234567895",
          url: "https://example.com/page2",
          options: {},
        }),
        addPageAnalyzeJobWithGuard(queue, {
          webPageId: "019bc123-4567-7890-abcd-ef1234567896",
          url: "https://example.com/page3",
          options: {},
        }),
      ]);

      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result.outcome).toBe("enqueued_new");
      }

      const health = await checkQueueHealth(queue);
      expect(health.stats.waiting).toBeGreaterThanOrEqual(3);
    });
  });

  // ============================================================
  // C-4 (Plan V1 §3.4): Deterministic currentPhase extractor tests.
  // ============================================================
  // These exercise `extractCurrentPhase` directly (no Redis required), and
  // include the prototype-pollution negative test mandated by the C-4 Wave 5
  // 4-statement commit body contract (Statement 2 / SEC S-2). The
  // Redis-conditional integration block below remains as the end-to-end
  // verifier when Redis is available.
  //
  // C-4 (Plan V1 §3.4): Redis 不要の決定論的 extractCurrentPhase テスト群。
  // Statement 2 / SEC S-2 が要求する prototype 汚染負例を含む。下の Redis
  // 依存ブロックは E2E verifier として保持。
  describe("extractCurrentPhase (pure helper)", () => {
    it("returns the validated AnalysisPhase from a well-formed progress object", () => {
      const progress = {
        overallProgress: 35,
        currentPhase: "motion",
        phases: {},
        webPageId: "019bc999-0001-7000-a000-000000000001",
        url: "https://example.com/phase-test",
        startedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
      };
      expect(extractCurrentPhase(progress)).toBe("motion");
    });

    it("returns undefined for a numeric progress payload (no phase info)", () => {
      expect(extractCurrentPhase(50)).toBeUndefined();
      expect(extractCurrentPhase(0)).toBeUndefined();
      expect(extractCurrentPhase(100)).toBeUndefined();
    });

    it("returns undefined for null / undefined progress", () => {
      expect(extractCurrentPhase(null)).toBeUndefined();
      expect(extractCurrentPhase(undefined)).toBeUndefined();
    });

    it("returns undefined for arrays (typeof === 'object' but not a valid carrier)", () => {
      expect(extractCurrentPhase(["motion"])).toBeUndefined();
      expect(extractCurrentPhase([])).toBeUndefined();
    });

    it("returns undefined for objects without a currentPhase own-property", () => {
      expect(extractCurrentPhase({ overallProgress: 35 })).toBeUndefined();
      expect(extractCurrentPhase({})).toBeUndefined();
    });

    it("returns undefined when currentPhase is not a string", () => {
      expect(extractCurrentPhase({ currentPhase: 123 })).toBeUndefined();
      expect(extractCurrentPhase({ currentPhase: null })).toBeUndefined();
      expect(extractCurrentPhase({ currentPhase: { nested: "motion" } })).toBeUndefined();
      expect(extractCurrentPhase({ currentPhase: ["motion"] })).toBeUndefined();
    });

    it("returns undefined for unknown / forged phase values (allowlist enforcement)", () => {
      expect(extractCurrentPhase({ currentPhase: "nonexistent_phase" })).toBeUndefined();
      expect(extractCurrentPhase({ currentPhase: "" })).toBeUndefined();
      expect(extractCurrentPhase({ currentPhase: "MOTION" })).toBeUndefined(); // case-sensitive
      expect(extractCurrentPhase({ currentPhase: "ingest " })).toBeUndefined(); // trailing space
    });

    it("accepts every documented AnalysisPhase value (exhaustive allowlist)", () => {
      const allPhases = [
        "ingest",
        "layout",
        "motion",
        "quality",
        "narrative",
        "responsive",
        "embedding",
      ] as const;
      for (const phase of allPhases) {
        expect(extractCurrentPhase({ currentPhase: phase })).toBe(phase);
      }
    });

    // ----------------------------------------------------------------
    // C-4 Statement 2 / SEC S-2: prototype-pollution negative tests.
    // ----------------------------------------------------------------
    // The previous implementation used the `in` operator, which traverses
    // the prototype chain — meaning `constructor` (inherited from
    // Object.prototype) would erroneously satisfy the carrier check. The
    // new implementation uses `Object.hasOwn`, closing this attack surface.
    //
    // 旧実装は `in` 演算子で prototype chain を辿り、`constructor` のような
    // 継承プロパティが carrier check を通過していた。新実装は `Object.hasOwn`
    // を使用し、prototype 経由の汚染ベクトルを構造的に閉じる。
    it("rejects __proto__ pollution attempts in progress payload", () => {
      // JSON.parse stores `__proto__` as an own data property (it does NOT
      // assign to the prototype), so this exercises the explicit Array /
      // own-property hardening path.
      const malicious = JSON.parse(
        '{"__proto__": {"polluted": true, "currentPhase": "motion"}}'
      ) as unknown;
      // The helper must not return the inherited "motion" value, and global
      // Object.prototype must remain untouched.
      expect(extractCurrentPhase(malicious)).toBeUndefined();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(({} as Record<string, unknown>).currentPhase).toBeUndefined();
    });

    it("rejects constructor-key pollution (own-property guard)", () => {
      // Without the `Object.hasOwn` guard, `"constructor" in {}` is `true`
      // (inherited from Object.prototype) — a forged JSON like
      // `{"constructor": "motion"}` would have leaked.
      // `Object.hasOwn` guard なしでは `"constructor" in {}` は true となり、
      // `{"constructor": "motion"}` のような偽造 JSON が通過してしまう。
      const forged = { constructor: "motion" };
      expect(extractCurrentPhase(forged)).toBeUndefined();
      // And an empty object must NOT report its inherited `constructor`
      // as a currentPhase carrier.
      expect(extractCurrentPhase({})).toBeUndefined();
    });

    it("rejects prototype-only carriers crafted via Object.create", () => {
      // Even when `currentPhase` exists ONLY on the prototype, the helper
      // must reject it (the Worker contract is to write own-properties).
      const prototypeOnly = Object.create({ currentPhase: "motion" }) as object;
      expect(extractCurrentPhase(prototypeOnly)).toBeUndefined();
    });

    it("does not leak when both __proto__ and own currentPhase are present", () => {
      // Mixed payload: own currentPhase is "ingest" (valid), prototype-route
      // attempts to inject "motion". Helper must read the own-property only.
      const mixed = JSON.parse(
        '{"__proto__": {"currentPhase": "motion"}, "currentPhase": "ingest"}'
      ) as unknown;
      expect(extractCurrentPhase(mixed)).toBe("ingest");
    });
  });

  describe("getJobStatus currentPhase logic", () => {
    // C-4 (Plan V1 §3.4) note: these end-to-end Redis integration tests are
    // **smoke checks** retained for backward compatibility with the previous
    // C-4 framing. The deterministic `extractCurrentPhase (pure helper)`
    // block above is the **primary verifier** of the extraction contract
    // (incl. prototype-pollution defense / SEC S-2 / Statement 2). When
    // Redis is unavailable they short-circuit; when available they exercise
    // the BullMQ round-trip but are subject to BullMQ's internal connection
    // ordering quirks that are NOT representative of production polling
    // (Worker writes → many-ms-later MCP client read).
    //
    // C-4 (Plan V1 §3.4): 以下の Redis 統合テストは smoke check。primary verifier
    // は上の pure helper 決定論テスト。Production の polling 経路では BullMQ の
    // internal connection 順序 quirk は影響しない。
    it("should extract currentPhase from object progress data", async () => {
      // getJobStatus requires a real queue, but we can verify the logic
      // by testing with a mock queue that returns a job with object progress
      const redisAvailable = await isRedisAvailable();
      if (!redisAvailable) {
        console.log("Skipping test: Redis not available");
        return;
      }

      const queue = createPageAnalyzeQueue();
      try {
        const webPageId = "019bc999-0001-7000-a000-000000000001";
        const result = await addPageAnalyzeJobWithGuard(queue, {
          webPageId,
          url: "https://example.com/phase-test",
          options: { features: { layout: true } },
        });

        // WithGuard returns EnqueueResult (no `.updateProgress`); retrieve the
        // real Job via the URL-stable jobId to drive progress updates.
        const job = await queue.getJob(result.jobId);
        expect(job).toBeDefined();

        // Simulate Worker updating progress with object data (as ExecutionStatusTrackerV2 does)
        await job!.updateProgress({
          overallProgress: 35,
          currentPhase: "motion",
          phases: {},
          webPageId,
          url: "https://example.com/phase-test",
          startedAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
        });

        const status = await getJobStatus(queue, result.jobId);

        expect(status).not.toBeNull();
        expect(status?.currentPhase).toBe("motion");
        expect(status?.progress).toBe(35);
      } finally {
        await queue.obliterate({ force: true });
        await closeQueue(queue);
      }
    });

    it("should not set currentPhase when progress is numeric (no phase info)", async () => {
      const redisAvailable = await isRedisAvailable();
      if (!redisAvailable) {
        console.log("Skipping test: Redis not available");
        return;
      }

      const queue = createPageAnalyzeQueue();
      try {
        const webPageId = "019bc999-0002-7000-a000-000000000002";
        const result = await addPageAnalyzeJobWithGuard(queue, {
          webPageId,
          url: "https://example.com/numeric-progress",
          options: { features: { layout: true } },
        });

        const job = await queue.getJob(result.jobId);
        expect(job).toBeDefined();

        // Simulate numeric-only progress (legacy behavior)
        await job!.updateProgress(50);

        const status = await getJobStatus(queue, result.jobId);

        expect(status).not.toBeNull();
        expect(status?.progress).toBe(50);
        expect(status?.currentPhase).toBeUndefined();
      } finally {
        await queue.obliterate({ force: true });
        await closeQueue(queue);
      }
    });

    it("should ignore invalid currentPhase values from progress data", async () => {
      const redisAvailable = await isRedisAvailable();
      if (!redisAvailable) {
        console.log("Skipping test: Redis not available");
        return;
      }

      const queue = createPageAnalyzeQueue();
      try {
        const webPageId = "019bc999-0003-7000-a000-000000000003";
        const result = await addPageAnalyzeJobWithGuard(queue, {
          webPageId,
          url: "https://example.com/invalid-phase",
          options: {},
        });

        const job = await queue.getJob(result.jobId);
        expect(job).toBeDefined();

        // Simulate progress with an invalid phase name
        await job!.updateProgress({
          overallProgress: 20,
          currentPhase: "nonexistent_phase",
          phases: {},
          webPageId,
          url: "https://example.com/invalid-phase",
          startedAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
        });

        const status = await getJobStatus(queue, result.jobId);

        expect(status).not.toBeNull();
        expect(status?.currentPhase).toBeUndefined();
      } finally {
        await queue.obliterate({ force: true });
        await closeQueue(queue);
      }
    });
  });

  describe("Graceful Degradation", () => {
    it("should handle queue creation when Redis is unavailable", () => {
      // This should not throw - queue creation is lazy
      // Use localhost to avoid DNS issues, just an unlikely port
      const queue = createPageAnalyzeQueue({
        host: "127.0.0.1",
        port: 59999,
      });

      expect(queue).toBeDefined();
      expect(queue.name).toBe(PAGE_ANALYZE_QUEUE_NAME);

      // Cleanup - don't wait for close since it can't connect
      queue.close().catch(() => {
        /* expected */
      });
    });

    // Note: Testing checkQueueHealth with unavailable Redis is skipped
    // because BullMQ Queue operations wait indefinitely for connection.
    // In production, this is handled by:
    // 1. isRedisAvailable() check before queue operations
    // 2. Connection timeouts at infrastructure level
    // 3. Monitoring and alerting on queue health metrics
    it.skip("should report unhealthy when Redis connection fails", async () => {
      // This test is skipped because BullMQ queue operations
      // don't have configurable timeouts and will wait for connection
    });
  });
});
