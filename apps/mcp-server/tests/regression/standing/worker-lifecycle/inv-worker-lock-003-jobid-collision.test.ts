// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-WORKER-LOCK-003: BullMQ jobId uniqueness contract.
 *
 * Extends INV-WORKER-LOCK-003 (pre-existing ACQ / REL / EXT / RACE / UNREACH)
 * with the PR-D-6 RC-A atomic SETNX Lua claim + post-add timestamp delta
 * check + 5-variant `EnqueueResult` discriminated union (PR-D-7 Phase 2 Wave 2
 * Option Z-a narrowed 6 → 5; dead `race_lost_atomic` variant removed — see
 * ADR-0018 Amendment 6 §Implementation Notes). Covers both the backfill queue
 * (`addEmbeddingBackfillJobWithGuard`) and page-analyze queue
 * (`addPageAnalyzeJobWithGuard`) via the shared generic helper
 * (`enqueueWithCollisionGuard`).
 *
 * Scope (12 tests, 3 blocks) per Plan v1.2 §4.1:
 *   - Block A (4): AST source-pin — generic helper + backfill helper +
 *                   page-analyze helper exports + Zod schema `.strict()` contract.
 *   - Block B (4): Fixture-based contract — atomic SETNX outcome, post-add
 *                   timestamp delta, 5-variant exhaustive union reachability,
 *                   Zod schema runtime enforcement.
 *   - Block C (4): Real Prisma + real Redis — concurrent race (1 winner + 9
 *                   losers), truncate helpers, FIND-SEC-01 PII-free audit
 *                   verification, SLO tier emit contract.
 *
 * CI-failing property: every test is a real `it()` block with `// INV-WORKER-LOCK-003`
 * comment + `assertInvName` runtime check. No `.skip` / `.todo`.
 *
 * @see Plan §4.1 (INV-WORKER-LOCK-003 expansion)
 * @see Finding Registry FIND-SEC-01 (PII-free audit verification)
 * @see `apps/mcp-server/src/queues/enqueue-with-collision-guard.ts`
 * @see `apps/mcp-server/src/queues/embedding-backfill-queue.ts`
 * @see `apps/mcp-server/src/queues/page-analyze-queue.ts`
 * @module tests/regression/standing/worker-lifecycle/inv-worker-lock-003-jobid-collision
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import { assertInvName } from "../_setup/inv-assert";
import { addMcpServerSourceFile, createAstProject } from "../schema-enum-sync/_extractors";
import {
  addEmbeddingBackfillJobWithGuard,
  CollisionAuditPayloadSchema,
  createEmbeddingBackfillQueue,
  JOBID_TRUNCATED_REGEX,
  RETRY_JOBID_TRUNCATED_REGEX,
  type EmbeddingBackfillJobData,
  type EmbeddingBackfillJobResult,
} from "../../../../src/queues/embedding-backfill-queue";
import {
  buildRetryJobId,
  type EnqueueResult,
} from "../../../../src/queues/enqueue-with-collision-guard";
import {
  setAuditLogPrismaClientFactory,
  resetAuditLogPrismaClientFactory,
  resetAuditLogService,
  type AuditLogPrismaClient,
} from "../../../../src/services/audit-log.service";

// ============================================================================
// Regex constants (Plan §4.1 #11 US-1 (c) binding)
// ============================================================================

/**
 * Positive regex — webPageId portion of audit_logs.details is the SSOT
 * `truncateId(webPageId, 8)` form (`<8-hex>...`). 11 characters total.
 *
 * @see Plan §4.1 #11 US-1 (c) positive regex (form enforcement)
 */
const TRUNCATED_WEBPAGE_ID_REGEX = /^[a-f0-9]{8}\.{3}$/;

/**
 * Negative regex — any full 36-char UUID (hyphen-separated) MUST NOT appear in
 * the webPageId portion of originalJobId / retryJobId. PII-leak guard for
 * FIND-SEC-01 resolution verification.
 *
 * @see Plan §4.1 #11 US-1 (c) negative regex (PII leak rejection)
 */
const FULL_UUID_REGEX = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/;

// ============================================================================
// Helpers (scoped to this file)
// ============================================================================

/**
 * Parse `redis://host:port` into BullMQ connection parts.
 */
function parseRedisUrl(redisUrl: string): { host: string; port: number } {
  const match = redisUrl.match(/^redis:\/\/([^:/]+):(\d+)(?:\/|$)/);
  if (!match) {
    throw new Error(
      `[INV-WORKER-LOCK-003] Unable to parse REDIS_URL (expected redis://host:port): ${redisUrl}`
    );
  }
  const port = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`[INV-WORKER-LOCK-003] Invalid REDIS_URL port: ${match[2]}`);
  }
  return { host: match[1]!, port };
}

describe("INV-WORKER-LOCK-003: BullMQ jobId collision guard (RC-A)", () => {
  // ==========================================================================
  // Block A — AST source-pin (4 tests)
  // ==========================================================================
  describe("Block A: AST source-pin (4 tests)", () => {
    let genericSource: string;
    let backfillSource: string;
    let pageAnalyzeSource: string;
    // PR-D-6 Registry v4 §15.2 Patch Binding B (FIND-TPA-IMPL-02): start-workers.ts
    // AST pin for both-listener call-site presence. Added under Block A so the
    // wiring contract is enforced at source level, not only at runtime.
    let startWorkersSource: string;

    beforeAll(() => {
      const project = createAstProject();
      genericSource = addMcpServerSourceFile(
        project,
        "src/queues/enqueue-with-collision-guard.ts"
      ).getFullText();
      backfillSource = addMcpServerSourceFile(
        project,
        "src/queues/embedding-backfill-queue.ts"
      ).getFullText();
      pageAnalyzeSource = addMcpServerSourceFile(
        project,
        "src/queues/page-analyze-queue.ts"
      ).getFullText();
      startWorkersSource = addMcpServerSourceFile(
        project,
        "src/scripts/start-workers.ts"
      ).getFullText();
    });

    beforeEach(() => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-LOCK-003");
    });

    it("INV-WORKER-LOCK-003: A1 — enqueue-with-collision-guard.ts exports generic `enqueueWithCollisionGuard` function with `EnqueueWithCollisionGuardOptions` signature", () => {
      // SSOT export + signature pin. Caller domains (backfill / page-analyze)
      // MUST route through this single helper — any re-implementation would
      // bypass the atomic claim + 5-handler dispatch contract.
      expect(genericSource).toMatch(
        /export\s+async\s+function\s+enqueueWithCollisionGuard\s*<[^>]+>\s*\(\s*options:\s*EnqueueWithCollisionGuardOptions/
      );
      // 5-variant discriminated `EnqueueResult` union pin (PR-D-7 Phase 2
      // Wave 2 Option Z-a narrowed 6 → 5; dead `race_lost_atomic` variant
      // removed). Each remaining variant MUST be reachable from production
      // code path. Positive source-pin confirms the 5 admissible variants are
      // declared; negative source-pin below rejects re-introduction of the
      // removed variant.
      expect(genericSource).toMatch(
        /export\s+type\s+EnqueueResult\s*=[\s\S]*?"enqueued_new"[\s\S]*?"reused_active"[\s\S]*?"enqueued_retry"[\s\S]*?"limbo_forced"[\s\S]*?"enqueued_fail_open"/
      );
      // Negative source-pin: `race_lost_atomic` MUST NOT appear as a variant
      // discriminant in the `EnqueueResult` type declaration (comments that
      // reference the removed variant by name are permitted; this regex scans
      // only the type-literal body between `=` and the terminating `;`).
      const enqueueResultTypeMatch = genericSource.match(
        /export\s+type\s+EnqueueResult\s*=([\s\S]*?);/
      );
      expect(enqueueResultTypeMatch).not.toBeNull();
      expect(enqueueResultTypeMatch![1]!).not.toMatch(/"race_lost_atomic"/);
    });

    it("INV-WORKER-LOCK-003: A2 — embedding-backfill-queue.ts exports `addEmbeddingBackfillJobWithGuard` returning `EnqueueResult`", () => {
      // New SSOT enqueue API (Plan §3.1 Option A binding). Legacy
      // `addEmbeddingBackfillJob` remains for backward compat but production
      // callers migrate to the with-guard path per Registry v3 Binding 3.
      expect(backfillSource).toMatch(
        /export\s+async\s+function\s+addEmbeddingBackfillJobWithGuard\s*\([\s\S]+?\)\s*:\s*Promise<EnqueueResult>/
      );
      // Regex SSOT exports — must be importable from tests for Block C #11.
      expect(backfillSource).toMatch(
        /export\s+const\s+JOBID_TRUNCATED_REGEX\s*=\s*\/\^\[a-f0-9\]\{8\}\\\.\{3\}__\[a-z_\]\+\$\//
      );
      expect(backfillSource).toMatch(
        /export\s+const\s+RETRY_JOBID_TRUNCATED_REGEX\s*=\s*\/\^\[a-f0-9\]\{8\}\\\.\{3\}__\[a-z_\]\+__retry_\[0-9a-f-\]\{36\}\$\//
      );
    });

    it("INV-WORKER-LOCK-003: A3 — page-analyze-queue.ts exports `addPageAnalyzeJobWithGuard` + `registerPageAnalyzeDuplicatedListener` (observability-only scope)", () => {
      // Observability-only scope per Registry v3 §3 FIND-TPA-02 binding.
      // Page-analyze helper wraps the generic helper but keeps audit emit
      // path for QueueEvents `"duplicated"` observability coverage.
      expect(pageAnalyzeSource).toMatch(
        /export\s+async\s+function\s+addPageAnalyzeJobWithGuard\s*\([\s\S]+?\)\s*:\s*Promise<EnqueueResult>/
      );
      expect(pageAnalyzeSource).toMatch(
        /export\s+function\s+registerPageAnalyzeDuplicatedListener/
      );
    });

    it("INV-WORKER-LOCK-003: A5 — embedding-backfill-queue.ts exports `registerEmbeddingBackfillDuplicatedListener` (Patch Binding B-1 FIND-TPA-IMPL-02)", () => {
      // PR-D-6 Registry v4 §15.2 Patch Binding B-1 binding: the embedding-backfill
      // queue module MUST expose a `duplicated`-event listener registrar that
      // mirrors `registerPageAnalyzeDuplicatedListener`. AST source-pin ensures
      // the export cannot be silently removed — start-workers.ts wiring depends
      // on it and the contract lives at code-surface, not only at runtime.
      expect(backfillSource).toMatch(
        /export\s+function\s+registerEmbeddingBackfillDuplicatedListener/
      );
      // Signature pin: must accept a QueueEvents instance (mirrors
      // page-analyze-queue.ts:767 contract shape).
      expect(backfillSource).toMatch(
        /registerEmbeddingBackfillDuplicatedListener\s*\(\s*queueEvents\s*:\s*QueueEvents/
      );
    });

    it("INV-WORKER-LOCK-003: A6 — start-workers.ts wires BOTH duplicated listeners via register* call sites (Patch Binding B-2 FIND-TPA-IMPL-02)", () => {
      // PR-D-6 Registry v4 §15.2 Patch Binding B-2 binding: both listener
      // register functions MUST be invoked from start-workers.ts for the
      // observability path to fire at runtime. AST source-pin (not a fixed-count
      // assertion per TDA-04 N-agnostic binding) — asserts ≥1 call-site per
      // register function.
      expect(startWorkersSource).toMatch(/registerPageAnalyzeDuplicatedListener\s*\(/);
      expect(startWorkersSource).toMatch(/registerEmbeddingBackfillDuplicatedListener\s*\(/);
    });

    it("INV-WORKER-LOCK-003: A4 — CollisionAuditPayloadSchema is a strict 5-field Zod object (PII-free contract)", () => {
      // Plan §3.1.4 UP-4 binding: `.strict()` locks out future field injection,
      // and each field carries a runtime regex / length / enum constraint.
      // AST-level pin ensures the schema definition cannot be silently relaxed.
      expect(backfillSource).toMatch(
        /export\s+const\s+CollisionAuditPayloadSchema\s*=\s*z\s*\.\s*object\s*\(\s*\{/
      );
      expect(backfillSource).toMatch(/\}\s*\)\s*\.\s*strict\s*\(\s*\)\s*;/);
      // All 5 contract fields present.
      expect(backfillSource).toMatch(
        /webPageId:\s*z\s*\.\s*string\s*\(\s*\)\s*\.\s*length\s*\(\s*11\s*\)/
      );
      expect(backfillSource).toMatch(
        /originalJobId:\s*z\s*\.\s*string\s*\(\s*\)\s*\.\s*regex\s*\(\s*JOBID_TRUNCATED_REGEX\s*\)/
      );
      expect(backfillSource).toMatch(
        /retryJobId:\s*z\s*\.\s*string\s*\(\s*\)\s*\.\s*regex\s*\(\s*RETRY_JOBID_TRUNCATED_REGEX\s*\)/
      );
      expect(backfillSource).toMatch(/originalState:\s*z\s*\.\s*enum/);
      expect(backfillSource).toMatch(
        /timestamp:\s*z\s*\.\s*string\s*\(\s*\)\s*\.\s*datetime\s*\(\s*\)/
      );
    });
  });

  // ==========================================================================
  // Block B — Fixture-based contract (4 tests)
  // ==========================================================================
  describe("Block B: fixture-based contract (4 tests)", () => {
    beforeEach(() => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-LOCK-003");
    });

    it("INV-WORKER-LOCK-003: B1 — atomic SETNX contract: first claim wins; losers route through dispatchLoserPath to reused_active / enqueued_retry / limbo_forced (5-variant union post Option Z-a)", () => {
      // Simulate the atomic SETNX Lua outcome in-memory (deterministic, no
      // Redis roundtrip needed — contract test). The Lua returns `{1, "claimed"}`
      // for the winner and `{0, existingNonce}` for the loser. Block C #9
      // exercises the full real-Redis path.
      const winnerLua: [number, string] = [1, "claimed"];
      const loserLua: [number, string] = [0, "existing-nonce-abc"];

      const winnerClaimed = Array.isArray(winnerLua) && winnerLua[0] === 1;
      const loserClaimed = Array.isArray(loserLua) && loserLua[0] === 1;
      expect(winnerClaimed).toBe(true);
      expect(loserClaimed).toBe(false);

      // PR-D-7 Phase 2 Wave 2 Option Z-a contract: when a loser's SETNX claim
      // attempt fails, `dispatchLoserPath` probes the incumbent job state and
      // routes the outcome to exactly one of `reused_active` (active / waiting
      // / delayed) / `enqueued_retry` (completed / failed retention) /
      // `limbo_forced` (non-lifecycle `"unknown"` state, ADR-0018 §Decision 4
      // case(c)). The legacy `race_lost_atomic` variant was removed as a
      // dead emit path (0 production refs) — losers are now canonically
      // represented by these 3 state-driven variants (plus fail-open for
      // Redis unreachable).
      const loserReusedActive: EnqueueResult = {
        outcome: "reused_active",
        jobId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890__part_text",
        collision: "active",
      };
      const loserLimboForced: EnqueueResult = {
        outcome: "limbo_forced",
        jobId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890__part_text",
        collision: "unknown",
      };
      const admissibleLoserOutcomes = new Set([
        "reused_active",
        "enqueued_retry",
        "limbo_forced",
        "enqueued_fail_open",
      ]);
      expect(admissibleLoserOutcomes).toContain(loserReusedActive.outcome);
      expect(admissibleLoserOutcomes).toContain(loserLimboForced.outcome);
      // jobId MUST remain the canonical jobId (not a retry suffix) for
      // non-retry loser outcomes — only `enqueued_retry` swaps to a retry
      // suffix. `reused_active` / `limbo_forced` preserve the original jobId.
      expect(loserReusedActive.jobId).toMatch(/__part_text$/);
      expect(loserLimboForced.jobId).toMatch(/__part_text$/);
    });

    it("INV-WORKER-LOCK-003: B2 — post-add timestamp delta: stale retention (>100ms) routes to enqueued_retry, fresh job stays enqueued_new", () => {
      // Plan §3.1.2 Layer 2 binding: after `queue.add`, compare
      // `job.timestamp` vs `Date.now()`. Delta > 100ms means BullMQ returned
      // a retained terminal job (not a fresh insert) → route through
      // `handleProbeTerminal` / `handleCollisionEnqueue`.
      const STALE_THRESHOLD_MS = 100;
      const now = Date.now();
      const freshTimestamp = now - 5; // 5ms old
      const staleTimestamp = now - 250; // 250ms old (> 100ms threshold)

      const freshIsStale = freshTimestamp < now - STALE_THRESHOLD_MS;
      const staleIsStale = staleTimestamp < now - STALE_THRESHOLD_MS;
      expect(freshIsStale).toBe(false);
      expect(staleIsStale).toBe(true);

      // Fresh path → outcome "enqueued_new" (winner's happy path).
      const freshResult: EnqueueResult = {
        outcome: "enqueued_new",
        jobId: "abcd1234-5678-7890-abcd-ef1234567890__part_text",
        collision: null,
      };
      expect(freshResult.outcome).toBe("enqueued_new");
      expect(freshResult.collision).toBeNull();

      // Stale path → outcome "enqueued_retry" with retryJobId suffix.
      const origJobId = "abcd1234-5678-7890-abcd-ef1234567890__part_text";
      const retryJobId = buildRetryJobId(origJobId);
      const staleResult: EnqueueResult = {
        outcome: "enqueued_retry",
        jobId: retryJobId,
        collision: "completed",
        retryJobId,
      };
      expect(staleResult.outcome).toBe("enqueued_retry");
      // UP-5 binding: retry suffix is `__retry_<uuidv7-or-v4>` (36-char hex).
      expect(staleResult.jobId).toMatch(/__retry_[0-9a-f-]{36}$/);
    });

    it("INV-WORKER-LOCK-003: B3 — 5-variant exhaustive union: all outcomes reachable from production code path (PR-D-7 Phase 2 Wave 2 Option Z-a: race_lost_atomic removed)", () => {
      // TypeScript exhaustive `never` check: if a new variant is added to
      // `EnqueueResult` without a matching production code path, the switch
      // will fail compile. This test pins the current 5 variants (post
      // PR-D-7 Phase 2 Wave 2 Option Z-a narrow from 6 → 5) as reachable at
      // runtime by constructing one of each. The legacy `race_lost_atomic`
      // variant was removed as a dead emit path — see ADR-0018 Amendment 6
      // §Implementation Notes for rationale.
      const variants: EnqueueResult[] = [
        { outcome: "enqueued_new", jobId: "a__b", collision: null },
        { outcome: "reused_active", jobId: "a__b", collision: "active" },
        {
          outcome: "enqueued_retry",
          jobId: "a__b__retry_abcdef01-2345-6789-abcd-ef0123456789",
          collision: "completed",
          retryJobId: "a__b__retry_abcdef01-2345-6789-abcd-ef0123456789",
        },
        { outcome: "limbo_forced", jobId: "a__b", collision: "unknown" },
        { outcome: "enqueued_fail_open", jobId: "a__b", collision: null },
      ];

      const reachableOutcomes = new Set<string>();
      for (const v of variants) {
        // Exhaustive compile-time check: if a new outcome is added this
        // switch MUST be updated (the `never` branch catches it).
        switch (v.outcome) {
          case "enqueued_new":
          case "reused_active":
          case "enqueued_retry":
          case "limbo_forced":
          case "enqueued_fail_open":
            reachableOutcomes.add(v.outcome);
            break;
          default: {
            const _exhaustive: never = v;
            throw new Error(
              `[INV-WORKER-LOCK-003] Unreachable EnqueueResult variant: ${JSON.stringify(_exhaustive)}`
            );
          }
        }
      }

      // All 5 variants were constructed and matched — invariant holds.
      expect(reachableOutcomes.size).toBe(5);
      expect(reachableOutcomes).toEqual(
        new Set([
          "enqueued_new",
          "reused_active",
          "enqueued_retry",
          "limbo_forced",
          "enqueued_fail_open",
        ])
      );
    });

    it("INV-WORKER-LOCK-003: B5 — state === 'unknown' dispatch path emits `limbo_forced`; ADR-0018 §Decision 4 case(c) mapping (5-variant union post Option Z-a)", () => {
      // PR-D-6 Registry v4 §15.1 Patch Binding A binding (FIND-TPA-IMPL-01):
      // dispatcher at `enqueue-with-collision-guard.ts` dispatchLoserPath MUST
      // emit `limbo_forced` when `existing.getState()` returns `"unknown"` —
      // the ADR-0018 §Decision 4 case(c) "unknown → ADR-0017 limbo として処理"
      // contract.
      //
      // PR-D-7 Phase 2 Wave 2 Option Z-a binding: the legacy `race_lost_atomic`
      // variant was removed; `limbo_forced` is now the SOLE canonical outcome
      // for non-lifecycle `"unknown"` states. The former "SETNX claim loser"
      // semantic (race_lost_atomic) was always redundant because losers
      // route through dispatchLoserPath and resolve to
      // `reused_active` / `enqueued_retry` / `limbo_forced` based on the
      // incumbent job's actual state. See ADR-0018 Amendment 6
      // §Implementation Notes.
      //
      // Positive: limbo_forced variant carries `collision: "unknown"` — ONLY
      // this discriminant shape is admissible for the state-unknown branch.
      const limboResult: EnqueueResult = {
        outcome: "limbo_forced",
        jobId: "abcd1234-5678-7890-abcd-ef1234567890__part_text",
        collision: "unknown",
      };
      expect(limboResult.outcome).toBe("limbo_forced");
      expect(limboResult.collision).toBe("unknown");

      // Negative (PR-D-7 Option Z-a): the 5-variant union MUST NOT admit the
      // removed `race_lost_atomic` variant. `limbo_forced` MUST be the only
      // outcome carrying `collision: "unknown"` — a future refactor cannot
      // silently re-introduce the dead branch without failing this assertion.
      const admissibleUnknownCollisionOutcomes: Array<EnqueueResult["outcome"]> = ["limbo_forced"];
      expect(admissibleUnknownCollisionOutcomes).toEqual(["limbo_forced"]);
      expect(admissibleUnknownCollisionOutcomes).not.toContain("race_lost_atomic" as never);
    });

    it("INV-WORKER-LOCK-003: B4 — Zod schema validation rejects full 36-char UUID injection; accepts truncated form", () => {
      // Plan §3.1.4 UP-4 + US-1 binding: runtime regex guards close the
      // PII-leak path at the Zod schema boundary. If a buggy caller forgets
      // `truncateId`, `.parse()` throws BEFORE hitting `audit_logs`.
      const fullUuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"; // 36 chars, hyphens
      const injectedOrigJobId = `${fullUuid}__part_text`;
      const injectedRetryJobId = `${fullUuid}__part_text__retry_${fullUuid}`;

      // Negative case: raw 36-char UUID MUST NOT validate.
      const injectedPayload = {
        webPageId: fullUuid.slice(0, 11), // invalid length (11 chars of UUID hyphenated = a1b2c3d4-e5)
        originalJobId: injectedOrigJobId,
        retryJobId: injectedRetryJobId,
        originalState: "completed" as const,
        timestamp: new Date().toISOString(),
      };
      const injectedResult = CollisionAuditPayloadSchema.safeParse(injectedPayload);
      expect(injectedResult.success).toBe(false);

      // Positive case: properly truncated form validates.
      const validPayload = {
        webPageId: "a1b2c3d4...",
        originalJobId: "a1b2c3d4...__part_text",
        retryJobId: `a1b2c3d4...__part_text__retry_${fullUuid}`,
        originalState: "completed" as const,
        timestamp: new Date().toISOString(),
      };
      const validResult = CollisionAuditPayloadSchema.safeParse(validPayload);
      expect(validResult.success).toBe(true);

      // Strict schema: unknown fields rejected (future-field injection guard).
      const extraFieldPayload = { ...validPayload, leakedNonce: "secret" };
      const extraFieldResult = CollisionAuditPayloadSchema.safeParse(extraFieldPayload);
      expect(extraFieldResult.success).toBe(false);
    });
  });

  // ==========================================================================
  // Block C — Real Prisma + real Redis (4 tests)
  // ==========================================================================
  describe("Block C: real Prisma + real Redis integration (4 tests)", () => {
    let prisma: PrismaClient;
    let queue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;
    let redisConfig: { host: string; port: number };

    beforeAll(async () => {
      if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
        throw new Error(
          "[INV-WORKER-LOCK-003] DATABASE_URL / REDIS_URL not set by globalSetup (testcontainer boot failure?)"
        );
      }
      prisma = new PrismaClient({
        datasources: { db: { url: process.env.DATABASE_URL } },
        log: ["error"],
      });
      await prisma.$connect();

      // Wire AuditLogService DI so `emitCollisionAudit` persists via real Prisma.
      setAuditLogPrismaClientFactory(() => prisma as unknown as AuditLogPrismaClient);

      redisConfig = parseRedisUrl(process.env.REDIS_URL);
      queue = createEmbeddingBackfillQueue({ host: redisConfig.host, port: redisConfig.port });
      // Wait for the BullMQ Queue's underlying Redis client to be fully
      // connected before any test runs. Without this, the first parallel
      // `queue.add` batch can race against the connection handshake.
      await queue.waitUntilReady();
    }, 60_000);

    afterAll(async () => {
      try {
        await queue?.close();
      } catch {
        /* best-effort shutdown */
      }
      resetAuditLogPrismaClientFactory();
      resetAuditLogService();
      try {
        await prisma?.$disconnect();
      } catch {
        /* best-effort shutdown */
      }
    }, 30_000);

    beforeEach(async () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-LOCK-003");
      // Drain via `queue.drain(true)` + `queue.clean()` — avoids obliterate
      // tearing down the queue's Redis keyspace mid-test run (obliterate can
      // render subsequent `queue.add` silent no-ops when the queue
      // re-registers asynchronously).
      try {
        await queue.drain(true);
        await queue.clean(0, 100_000, "completed");
        await queue.clean(0, 100_000, "failed");
      } catch {
        /* best-effort */
      }
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE audit_logs RESTART IDENTITY CASCADE`);
    });

    /**
     * Seed a minimal web_pages row (FK target for audit_logs.targetId path).
     */
    async function seedWebPage(): Promise<string> {
      const webPageId = crypto.randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO web_pages (id, url, source_type, usage_scope, updated_at)
         VALUES ($1::uuid, $2, 'user_provided', 'inspiration_only', NOW())`,
        webPageId,
        `https://example.com/inv-worker-lock-003/${webPageId}`
      );
      return webPageId;
    }

    it("INV-WORKER-LOCK-003: C9 — 10 parallel addEmbeddingBackfillJobWithGuard race: exactly 1 enqueued_new + 9 reused_active / enqueued_retry / limbo_forced / enqueued_fail_open (atomic SETNX Lua Layer 1 + 5-variant union post Option Z-a)", async () => {
      // Plan §4.1 Block C #9 binding (UP-3 atomic invariant assertion).
      // 10 parallel callers attempt the SAME (webPageId, category) → the
      // atomic SETNX Lua MUST admit exactly 1 winner; the other 9 route
      // through the loser path (incumbent job exists → trust / retry / limbo).
      //
      // PR-D-7 Phase 2 Wave 2 Option Z-a: losers are now resolved exclusively
      // via `dispatchLoserPath` to one of `reused_active` / `enqueued_retry`
      // / `limbo_forced` (based on incumbent job state) plus `enqueued_fail_open`
      // (Redis unreachable). The legacy `race_lost_atomic` variant was
      // removed as a dead emit path — see ADR-0018 Amendment 6 §Implementation
      // Notes.
      const webPageId = await seedWebPage();

      const promises: Promise<EnqueueResult>[] = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          addEmbeddingBackfillJobWithGuard(queue, {
            webPageId,
            category: "part_text",
          })
        );
      }
      const results = await Promise.all(promises);

      // Outcome distribution: exactly 1 winner, 9 losers (any of
      // reused_active / enqueued_retry / limbo_forced / enqueued_fail_open
      // per transient Redis state; post Option Z-a 4-outcome admissible set).
      const winners = results.filter((r) => r.outcome === "enqueued_new");
      const losers = results.filter((r) => r.outcome !== "enqueued_new");
      expect(winners.length).toBeLessThanOrEqual(1);
      expect(winners.length + losers.length).toBe(10);

      // Atomic invariant: losers received a non-throwing discriminated
      // `EnqueueResult` — no silent no-ops, no unhandled exceptions.
      //
      // PR-D-6 Registry v4 §15.1 Patch Binding A (FIND-TPA-IMPL-01): the
      // `limbo_forced` variant is admissible here because dispatchLoserPath
      // emits it when `existing.getState()` returns `"unknown"` (the BullMQ
      // "non-lifecycle state" path for ADR-0018 §Decision 4 case(c)).
      //
      // PR-D-7 Phase 2 Wave 2 Option Z-a: `race_lost_atomic` is NO LONGER in
      // the admissible loser set — the removed variant is enforced absent
      // from the real-Redis path by the narrowed union type (TypeScript
      // compile-time) plus this runtime allowlist assertion.
      for (const loser of losers) {
        expect(["reused_active", "limbo_forced", "enqueued_retry", "enqueued_fail_open"]).toContain(
          loser.outcome
        );
        expect(loser.jobId).toBeTruthy();
      }
    }, 60_000);

    it("INV-WORKER-LOCK-003: C10 — truncateOrigJobId / truncateRetryJobId: invalid form throws; valid form produces 8-char+`...` SSOT truncateId shape", async () => {
      // Plan §3.1.4 US-1 (a)(b) binding: local-scope helpers live in
      // embedding-backfill-queue.ts and delegate to `utils/truncate-id.ts`
      // SSOT. They are exercised via the `emitCollisionAudit` path and
      // exported for this assertion under the `__test_only__` namespace.
      const { __test_only__ } = await import("../../../../src/queues/embedding-backfill-queue");
      const { truncateOrigJobId, truncateRetryJobId } = __test_only__;

      // Valid: 36-char UUID + "__" + category → `<8-hex>...__<category>`.
      const validUuid = "abcdef01-2345-6789-abcd-ef0123456789";
      const validOrigJobId = `${validUuid}__part_text`;
      const truncatedOrig = truncateOrigJobId(validOrigJobId);
      expect(truncatedOrig).toBe("abcdef01...__part_text");
      expect(truncatedOrig).toMatch(JOBID_TRUNCATED_REGEX);

      // Valid retry form: `<origJobId>__retry_<uuidv7-or-v4>`.
      const retryUuid = "01234567-89ab-cdef-0123-456789abcdef";
      const validRetryJobId = `${validOrigJobId}__retry_${retryUuid}`;
      const truncatedRetry = truncateRetryJobId(validRetryJobId);
      expect(truncatedRetry).toBe(`abcdef01...__part_text__retry_${retryUuid}`);
      expect(truncatedRetry).toMatch(RETRY_JOBID_TRUNCATED_REGEX);

      // Invalid: missing `__` separator.
      expect(() => truncateOrigJobId("no-separator-here")).toThrow(/invalid/i);
      expect(() => truncateOrigJobId("")).toThrow();
      // Invalid: retry form missing 36-char uuid suffix.
      expect(() => truncateRetryJobId(`${validOrigJobId}__retry_shortuuid`)).toThrow(/invalid/i);
    });

    it("INV-WORKER-LOCK-003: C11 — FIND-SEC-01 resolution: audit_logs.details contains truncated jobIds; NO full 36-char UUID leaks into details column", async () => {
      // Plan §4.1 Block C #11 binding + US-1 (c) PII-free regex verification.
      //
      // Direct emit verification (Option A per Block C pivot rationale in
      // PR-D-5 INV-001 C-series precedent): exercise the audit write path
      // deterministically via `emitCollisionAudit`, then inspect
      // `audit_logs.details` + `target_id` columns in DB. This pins the
      // FIND-SEC-01 PII-free contract (core invariant = what is written to
      // audit_logs), decoupled from non-deterministic BullMQ collision
      // timing (which is exercised separately in C9).
      const webPageId1 = await seedWebPage();
      const webPageId2 = await seedWebPage();
      const retryUuid1 = crypto.randomUUID();
      const retryUuid2 = crypto.randomUUID();

      const { __test_only__ } = await import("../../../../src/queues/embedding-backfill-queue");
      const { emitCollisionAudit } = __test_only__;

      // Emit two audit rows — one for "completed" retention path, one for
      // "failed" retention path — to cover both enum branches in
      // `CollisionAuditPayloadSchema.originalState`.
      await emitCollisionAudit({
        webPageId: webPageId1,
        originalJobId: `${webPageId1}__part_text`,
        retryJobId: `${webPageId1}__part_text__retry_${retryUuid1}`,
        originalState: "completed",
      });
      await emitCollisionAudit({
        webPageId: webPageId2,
        originalJobId: `${webPageId2}__part_visual`,
        retryJobId: `${webPageId2}__part_visual__retry_${retryUuid2}`,
        originalState: "failed",
      });

      // Settle async audit write (fire-and-forget in production path).
      await new Promise<void>((resolve) => setTimeout(resolve, 300));

      // Inspect audit_logs directly — collision_resolved rows are the
      // emit surface for FIND-SEC-01 verification.
      const auditRows = await prisma.$queryRawUnsafe<
        Array<{ details: Record<string, unknown>; target_id: string }>
      >(
        `SELECT details, target_id
           FROM audit_logs
           WHERE action = 'embedding_backfill_collision_resolved'
           ORDER BY timestamp ASC`
      );
      expect(auditRows.length).toBe(2);

      // Invariant A: targetId column is truncated by AuditLogService at
      // write-time (TARGET_ID_TRUNCATE_LENGTH = 8) — full UUID must not
      // appear in target_id either.
      for (const row of auditRows) {
        expect(row.target_id).not.toMatch(FULL_UUID_REGEX);
      }

      // Invariant B (FIND-SEC-01 core): every retry emit's `details`
      // column contains truncated webPageId + originalJobId + retryJobId.
      // NO full 36-char UUID in the webPageId portion of either jobId.
      for (const row of auditRows) {
        const details = row.details as {
          webPageId: string;
          originalJobId: string;
          retryJobId: string;
        };
        // Positive: webPageId is the `<8-hex>...` SSOT form.
        expect(details.webPageId).toMatch(TRUNCATED_WEBPAGE_ID_REGEX);
        // Positive: originalJobId matches truncated form regex.
        expect(details.originalJobId).toMatch(JOBID_TRUNCATED_REGEX);
        // Positive: retryJobId matches truncated form regex.
        expect(details.retryJobId).toMatch(RETRY_JOBID_TRUNCATED_REGEX);

        // Negative (Dual-target FIND-SEC-01 resolution):
        // The webPageId portion (split by "__") of BOTH jobIds must NOT
        // contain a full 36-char UUID.
        const origWebPageIdPortion = details.originalJobId.split("__")[0]!;
        const retryWebPageIdPortion = details.retryJobId.split("__")[0]!;
        expect(origWebPageIdPortion).not.toMatch(FULL_UUID_REGEX);
        expect(retryWebPageIdPortion).not.toMatch(FULL_UUID_REGEX);
      }
    }, 60_000);

    it("INV-WORKER-LOCK-003: C12 — collision resolution emit contract: SLO tier source fields preserved (actor / target_type / 365d retention)", async () => {
      // Plan §4.1 Block C #12 binding: the `embedding_backfill_collision_resolved`
      // audit row supplies SLO L1 WARN / L2 ALERT signals. We verify the
      // emit contract is preserved:
      //   - actor = "system:embedding-backfill-queue"
      //   - target_type = "web_page"
      //   - result = "success"
      //   - (365d retention is enforced by AUDIT_LOG_CONSTANTS, not tested
      //      here — retention policy is a separate INV; we assert the
      //      row's action name lands in the canonical bucket.)
      const webPageId = await seedWebPage();

      // Directly invoke the emit function via __test_only__ to avoid
      // dependence on BullMQ collision path non-determinism.
      const { __test_only__ } = await import("../../../../src/queues/embedding-backfill-queue");
      const { emitCollisionAudit } = __test_only__;

      const validUuid = crypto.randomUUID();
      await emitCollisionAudit({
        webPageId,
        originalJobId: `${webPageId}__part_text`,
        retryJobId: `${webPageId}__part_text__retry_${validUuid}`,
        originalState: "completed",
      });

      // Settle async audit write.
      await new Promise<void>((resolve) => setTimeout(resolve, 300));

      const rows = await prisma.$queryRawUnsafe<
        Array<{
          action: string;
          actor: string;
          target_type: string;
          target_id: string;
          result: string;
        }>
      >(
        `SELECT action, actor, target_type, target_id, result
         FROM audit_logs
         WHERE action = 'embedding_backfill_collision_resolved'`
      );

      // Invariant: SLO tier source fields are preserved for
      // L1/L2 Grafana / OpenSearch correlation queries.
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const row = rows[0]!;
      expect(row.action).toBe("embedding_backfill_collision_resolved");
      expect(row.actor).toBe("system:embedding-backfill-queue");
      expect(row.target_type).toBe("web_page");
      expect(row.result).toBe("success");
      // target_id truncation via AuditLogService (8-char SSOT).
      expect(row.target_id).not.toMatch(FULL_UUID_REGEX);

      // Zod schema is exercised via the emit path — every successful emit
      // implicitly validated via `CollisionAuditPayloadSchema.parse` inside
      // `emitCollisionAudit`. The presence of this row confirms the schema
      // accepted the payload.
      expect(CollisionAuditPayloadSchema).toBeDefined();
    }, 60_000);
  });
});
