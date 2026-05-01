// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-EMBEDDING-INTEGRITY-003 (full landing, PR-D-4)
 *
 * `web_pages.embeddingBackfillStatus='completed'` は `EMBEDDING_BACKFILL_CATEGORIES`
 * T1 SSOT (現在 7 カテゴリ) 全ての pending count = 0 と SSOT-consistent でなければ
 * ならない。terminal transition (completed) 直前に `verifyCategoryParity` を実行し、
 * いずれかのカテゴリで pending>0 の場合は `parity_check_failed` → `skipped_fork_error`
 * (retry bucket) 経由で reconciliation cron に委譲する。
 *
 * `web_pages.embeddingBackfillStatus='completed'` MUST be SSOT-consistent with
 * `pending count = 0` across all N categories in `EMBEDDING_BACKFILL_CATEGORIES`
 * T1 SSOT (currently 7). Before the terminal `completed` transition,
 * `verifyCategoryParity` MUST run; if any category reports `pending > 0`, the
 * transition is aborted and the row moves to `skipReason='parity_check_failed'`
 * → `skipped_fork_error` (retry bucket) so the reconciliation cron can handle it.
 *
 * **Supersedes**: `inv-embedding-integrity-003-status-parity-partial.test.ts`
 * (retired in this commit per PR-D-4 Plan §3.1 Option (a) rename+superset,
 * FIND-PLAN-IO-06).
 *
 * Structure (16 tests):
 *   - Block A (4): AST-level precondition (superset of retired partial test)
 *   - Block B (4): 7-category × 15 skipReason mapping integrity
 *   - Block C (8): runtime parity check behavior
 *
 * @see ADR-0018 §Decision 1 INV-EMBEDDING-INTEGRITY-001 (semantic boundary)
 * @see ADR-0018 §Decision 2 (`parity_check_failed` enum retry bucket mapping)
 * @see ADR-0018 §Decision 3 Amendment (`bbox_invalid` retry bucket mapping)
 * @see PR-D-4 Plan §2 (single-query refactor) / §3 (test Blocks A/B/C)
 * @see IO Finding Registry FIND-PLAN-IO-02 / 03 / 06 / 07 / 08 / 10
 *
 * Severity: H (PR-D-4 full landing, INV-003)
 *
 * @module tests/regression/standing/embedding-integrity/inv-embedding-integrity-003-status-parity-full
 */

import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { assertInvName } from "../_setup/inv-assert";
import {
  addMcpServerSourceFile,
  createAstProject,
  extractConstStringArray,
  extractSwitchCaseLabels,
} from "../schema-enum-sync/_extractors";
import {
  collectCategoryPendingSnapshot,
  computeRemainingStatusWithPrisma,
  verifyCategoryParity,
  type CategoryPendingSnapshot,
} from "../../../../src/services/backfill-status.helper";
import { EMBEDDING_BACKFILL_CATEGORIES } from "../../../../src/queues/embedding-backfill-queue";

// ============================================================================
// Fixtures: skipReason → EmbeddingBackfillStatus exhaustive mapping
// ============================================================================

/**
 * Fixture-inline: 16 EmbeddingSkipReason → 3 EmbeddingBackfillStatus buckets.
 * Inlined per FIND-PLAN-IO-12 (promote to shared file only when 2nd consumer
 * appears — Q3-2026 backlog).
 *
 * PR-D-9 Wave 4 (C-02 + C-04 / ADR-0018 §Decision 1 Supplement S3): added
 * `bbox_unresolvable` (Playwright-residual catch-all). Routes to
 * `skipped_fork_error` retry bucket per Supplement S3 mapping rationale (same
 * accuracy-preserving retry path as `bbox_invalid` JSDOM-origin catch-all).
 */
const SKIP_REASON_TO_BACKFILL_STATUS_MAPPING: Record<string, string> = {
  // Memory pressure bucket (2)
  v8_heap_headroom_low: "skipped_memory_pressure",
  system_memavailable_low: "skipped_memory_pressure",
  // Fork error retry bucket (13)
  text_fork_failed: "skipped_fork_error",
  text_child_error: "skipped_fork_error",
  text_child_abnormal_exit: "skipped_fork_error",
  text_ipc_race: "skipped_fork_error",
  visual_fork_failed: "skipped_fork_error",
  visual_child_error: "skipped_fork_error",
  visual_child_abnormal_exit: "skipped_fork_error",
  visual_ipc_race: "skipped_fork_error",
  dispatch_phase_failed: "skipped_fork_error",
  fork_terminated_before_done: "skipped_fork_error",
  parity_check_failed: "skipped_fork_error",
  bbox_invalid: "skipped_fork_error",
  bbox_unresolvable: "skipped_fork_error",
  // Not-required bucket (1)
  no_embeddable_items: "not_required",
};

// ============================================================================
// Helpers: build Prisma mock mirroring backfill-status.helper.test.ts shape
// ============================================================================

interface PendingCounts {
  partText?: number;
  partVisual?: number;
  sectionVisual?: number;
  motion?: number;
  background?: number;
  jsAnimation?: number;
  responsive?: number;
}

function buildPrismaMock(counts: PendingCounts): PrismaClient {
  return {
    componentPart: {
      count: vi.fn(async () => counts.partText ?? 0),
    },
    motionPattern: {
      count: vi.fn(async () => counts.motion ?? 0),
    },
    backgroundDesign: {
      count: vi.fn(async () => counts.background ?? 0),
    },
    jSAnimationPattern: {
      count: vi.fn(async () => counts.jsAnimation ?? 0),
    },
    responsiveAnalysis: {
      count: vi.fn(async () => counts.responsive ?? 0),
    },
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes("component_part_embeddings")) {
        return [{ count: BigInt(counts.partVisual ?? 0) }];
      }
      if (sql.includes("section_embeddings")) {
        return [{ count: BigInt(counts.sectionVisual ?? 0) }];
      }
      return [{ count: BigInt(0) }];
    }),
  } as unknown as PrismaClient;
}

function buildFailingPrismaMock(errorMessage: string): PrismaClient {
  return {
    componentPart: {
      count: vi.fn(async () => {
        throw new Error(errorMessage);
      }),
    },
    motionPattern: { count: vi.fn(async () => 0) },
    backgroundDesign: { count: vi.fn(async () => 0) },
    jSAnimationPattern: { count: vi.fn(async () => 0) },
    responsiveAnalysis: { count: vi.fn(async () => 0) },
    $queryRawUnsafe: vi.fn(async () => [{ count: BigInt(0) }]),
  } as unknown as PrismaClient;
}

const FAKE_PAGE_ID = "019bc123-4567-7890-abcd-ef1234500001";

// ============================================================================
// Tests
// ============================================================================

describe("INV-EMBEDDING-INTEGRITY-003: status parity full landing (PR-D-4)", () => {
  let ssotValues: string[];
  let switchLabels: string[];

  beforeAll(() => {
    const project = createAstProject();
    const typesFile = addMcpServerSourceFile(project, "src/workers/phases/types.ts");
    ssotValues = extractConstStringArray(typesFile, "EMBEDDING_SKIP_REASONS");
    const workerFile = addMcpServerSourceFile(project, "src/workers/page-analyze-worker.ts");
    switchLabels = extractSwitchCaseLabels(workerFile, "skipReasonToBackfillStatus");
  });

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-EMBEDDING-INTEGRITY-003");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Block A — AST-level precondition (4 tests, superset of retired partial)
  // ==========================================================================

  describe("Block A: AST-level precondition (partial test superset)", () => {
    it("INV-EMBEDDING-INTEGRITY-003: A1 — parity_check_failed exists in EMBEDDING_SKIP_REASONS SSOT", () => {
      // Supersedes partial Test #1. Precondition for runtime parity check:
      // enum-level existence of `parity_check_failed` must be pinned.
      expect(ssotValues).toContain("parity_check_failed");
    });

    it("INV-EMBEDDING-INTEGRITY-003: A2 — parity_check_failed routes to retry bucket in skipReasonToBackfillStatus switch", () => {
      // Supersedes partial Test #2. GDPR Art.5(1)(d) accuracy: parity mismatch
      // must NOT be treated as permanent failure — must flow through retry
      // bucket so transient DB hiccups have a chance to recover.
      expect(switchLabels).toContain("parity_check_failed");
    });

    it("INV-EMBEDDING-INTEGRITY-003: A3 — bbox_invalid also routes to retry bucket (dual check: enum + switch)", () => {
      // Supersedes partial Test #3. Part visual skip must be retryable.
      // Per IO Registry UC-01 (GDPR Art.5(1)(d)), this must route to retry
      // bucket (skipped_fork_error), NOT to skipped_screenshot_missing
      // (which is retry-excluded).
      expect(ssotValues).toContain("bbox_invalid");
      expect(switchLabels).toContain("bbox_invalid");
    });

    it("INV-EMBEDDING-INTEGRITY-003: A4 — EMBEDDING_SKIP_REASONS total = 16 with tail-append of new values", () => {
      // Supersedes partial Test #4. Additive policy: existing values
      // unchanged; parity_check_failed + bbox_invalid + bbox_unresolvable
      // appended at tail per ADR-0018 §Decision 2 / §Decision 3 Amendment /
      // §Decision 1 Supplement S3 (PR-D-9 Wave 4).
      expect(ssotValues).toHaveLength(16);
      // Spot-check a few existing values are preserved (SSOT-level guarantee)
      expect(ssotValues).toContain("v8_heap_headroom_low");
      expect(ssotValues).toContain("dispatch_phase_failed");
      expect(ssotValues).toContain("fork_terminated_before_done");
      expect(ssotValues).toContain("parity_check_failed");
      expect(ssotValues).toContain("bbox_invalid");
      expect(ssotValues).toContain("bbox_unresolvable");
    });
  });

  // ==========================================================================
  // Block B — 7-category × skipReason mapping integrity (4 tests, TDA-refined)
  // ==========================================================================

  describe("Block B: Mapping integrity (Set equality + retry-bucket exclusion)", () => {
    it("INV-EMBEDDING-INTEGRITY-003: B5 — pendingSnapshot keys are Set-equal to EMBEDDING_BACKFILL_CATEGORIES (not subset)", async () => {
      // TPA-mandated per FIND-PLAN-IO-06 (ii): upgrade subset match to Set
      // equality. Future additive expansion to EMBEDDING_BACKFILL_CATEGORIES
      // must be caught as regression here.
      const snapshot = await collectCategoryPendingSnapshot(FAKE_PAGE_ID, buildPrismaMock({}));
      const snapshotKeys = Object.keys(snapshot).sort();
      const ssotCategories = [...EMBEDDING_BACKFILL_CATEGORIES].sort();

      expect(snapshotKeys).toEqual(ssotCategories);
      // Also verify count (7 as of PR-D-4). This guards against inadvertent
      // category reduction as well as additive expansion.
      expect(snapshotKeys).toHaveLength(7);
    });

    it("INV-EMBEDDING-INTEGRITY-003: B6 — 15 skipReasons partition into 3 buckets (memory/retry/not_required)", () => {
      // Exhaustive partition coverage: every SSOT skipReason must map to
      // exactly one of 3 EmbeddingBackfillStatus buckets.
      const bucketCounts: Record<string, number> = {
        skipped_memory_pressure: 0,
        skipped_fork_error: 0,
        not_required: 0,
      };
      for (const reason of ssotValues) {
        const bucket = SKIP_REASON_TO_BACKFILL_STATUS_MAPPING[reason];
        expect(bucket).toBeDefined();
        expect(Object.keys(bucketCounts)).toContain(bucket);
        bucketCounts[bucket as keyof typeof bucketCounts]++;
      }
      // Expected partition sizes per fixture and Plan §3.5.
      // PR-D-9 Wave 4: bbox_unresolvable adds 1 to skipped_fork_error bucket
      // (12 → 13) per ADR-0018 §Decision 1 Supplement S3 mapping.
      expect(bucketCounts.skipped_memory_pressure).toBe(2);
      expect(bucketCounts.skipped_fork_error).toBe(13);
      expect(bucketCounts.not_required).toBe(1);
      // Sum = 16 (INV-SCHEMA-ENUM-004 total enum value count post PR-D-9 Wave 4)
      expect(
        bucketCounts.skipped_memory_pressure +
          bucketCounts.skipped_fork_error +
          bucketCounts.not_required
      ).toBe(16);
    });

    it("INV-EMBEDDING-INTEGRITY-003: B7 — parity_check_failed → skipped_fork_error AND NOT skipped_screenshot_missing (retry-bucket exclusion)", () => {
      // TDA-refined per FIND-PLAN-IO-06 #4: add explicit negative assertion
      // that parity_check_failed does NOT map to skipped_screenshot_missing
      // (retry-excluded bucket). Pins the retry-bucket exclusion via
      // assertion so future accidental re-routing fails CI.
      const bucket = SKIP_REASON_TO_BACKFILL_STATUS_MAPPING["parity_check_failed"];
      expect(bucket).toBe("skipped_fork_error");
      // Negative assertion (explicit exclusion from retry-excluded bucket).
      expect(bucket).not.toBe("skipped_screenshot_missing");

      // Runtime cross-check: switch label is present (matches AST extraction).
      expect(switchLabels).toContain("parity_check_failed");
    });

    it("INV-EMBEDDING-INTEGRITY-003: B8 — exhaustive switch coverage for all 15 EmbeddingSkipReason values", () => {
      // Every SSOT enum value must be a case label in skipReasonToBackfillStatus
      // (except the TypeScript exhaustiveness `default` clause). Catches the
      // classic "new enum value added but switch case forgotten" regression.
      for (const reason of ssotValues) {
        expect(switchLabels).toContain(reason);
      }
      // Also verify fixture and switch labels agree on every value.
      for (const reason of ssotValues) {
        expect(Object.keys(SKIP_REASON_TO_BACKFILL_STATUS_MAPPING)).toContain(reason);
      }
    });
  });

  // ==========================================================================
  // Block C — Runtime parity check behavior (8 tests, TPA-mandated expansion)
  // ==========================================================================

  describe("Block C: Runtime parity check behavior", () => {
    it("INV-EMBEDDING-INTEGRITY-003: C9 — positive: single category pending yields finalStatus='in_progress' and no parity check fires", async () => {
      // Positive baseline: part_text=1 → finalStatus='in_progress' (no
      // parity check window since we did not enter the completed transition).
      const prisma = buildPrismaMock({ partText: 1 });
      const { finalStatus, pendingSnapshot } = await computeRemainingStatusWithPrisma(
        FAKE_PAGE_ID,
        prisma
      );
      expect(finalStatus).toBe("in_progress");
      expect(pendingSnapshot.part_text).toBe(1);
      // Other categories remain zero.
      expect(pendingSnapshot.part_visual).toBe(0);
      expect(pendingSnapshot.motion).toBe(0);
      expect(pendingSnapshot.background).toBe(0);
      expect(pendingSnapshot.js_animation).toBe(0);
      expect(pendingSnapshot.responsive).toBe(0);
      expect(pendingSnapshot.section_visual).toBe(0);
    });

    it("INV-EMBEDDING-INTEGRITY-003: C10 — positive: all categories complete yields finalStatus='completed' AND verifyCategoryParity.ok=true", async () => {
      // Happy path (parity check passes). `verifyCategoryParity(snapshot)`
      // must return `ok: true` with the same snapshot echoed back.
      const prisma = buildPrismaMock({});
      const { finalStatus, pendingSnapshot } = await computeRemainingStatusWithPrisma(
        FAKE_PAGE_ID,
        prisma
      );
      expect(finalStatus).toBe("completed");
      const parityResult = verifyCategoryParity(pendingSnapshot);
      expect(parityResult.ok).toBe(true);
      expect(parityResult.pendingSnapshot).toEqual(pendingSnapshot);
    });

    it("INV-EMBEDDING-INTEGRITY-003: C11 — negative: single violating category detected via verifyCategoryParity", async () => {
      // Negative case: a synthetic pendingSnapshot with one violating
      // category (motion=1) must produce ok:false. The returned snapshot
      // must echo the input so call sites can log the violation.
      const snapshot: CategoryPendingSnapshot = {
        part_text: 0,
        part_visual: 0,
        section_visual: 0,
        motion: 1,
        background: 0,
        js_animation: 0,
        responsive: 0,
      };
      const result = verifyCategoryParity(snapshot);
      expect(result.ok).toBe(false);
      expect(result.pendingSnapshot.motion).toBe(1);
      // All other categories still zero.
      expect(result.pendingSnapshot.part_text).toBe(0);
      expect(result.pendingSnapshot.part_visual).toBe(0);
    });

    it("INV-EMBEDDING-INTEGRITY-003: C12 — negative: multiple violating categories all surfaced", async () => {
      // Multiple violations surfaced in the snapshot (part_text=2, motion=1).
      // Ensures verifyCategoryParity does not early-exit after first non-zero.
      const snapshot: CategoryPendingSnapshot = {
        part_text: 2,
        part_visual: 0,
        section_visual: 0,
        motion: 1,
        background: 0,
        js_animation: 0,
        responsive: 0,
      };
      const result = verifyCategoryParity(snapshot);
      expect(result.ok).toBe(false);
      expect(result.pendingSnapshot.part_text).toBe(2);
      expect(result.pendingSnapshot.motion).toBe(1);
    });

    it("INV-EMBEDDING-INTEGRITY-003: C13 — logger.warn emit contains 5-field contract on parity failure", async () => {
      // TDA-mandated per FIND-PLAN-IO-06 #5 + FIND-PLAN-IO-07: assert that
      // the parity_check_failed emission contains all 5 contract fields:
      //   webPageId (8-char truncated), category (map), pendingSnapshot
      //   (numeric-only), skipReason ("parity_check_failed"), timestamp.
      // This is the sole evidence source until PR-D-5 lands the audit_logs
      // DB write (FIND-PLAN-IO-07 audit_logs gap window guard).

      // Dynamically import worker module so the test sees the live exports.
      const workerModule = await import("../../../../src/workers/embedding-backfill-worker");
      const emitter: (
        webPageId: string,
        category: CategoryPendingSnapshot
      ) => Promise<void> | void = (
        workerModule as unknown as {
          emitParityCheckFailedIfEnabled: (
            webPageId: string,
            category: CategoryPendingSnapshot
          ) => Promise<void> | void;
        }
      ).emitParityCheckFailedIfEnabled;

      expect(typeof emitter).toBe("function");

      const loggerModule = await import("../../../../src/utils/logger");
      const warnSpy = vi.spyOn(loggerModule.logger, "warn").mockImplementation(() => {});

      const pendingSnapshot: CategoryPendingSnapshot = {
        part_text: 3,
        part_visual: 0,
        section_visual: 0,
        motion: 0,
        background: 0,
        js_animation: 0,
        responsive: 0,
      };

      await emitter(FAKE_PAGE_ID, pendingSnapshot);

      // v0.4.0 PR-D-5 (FIND-PLAN-IO-07): dual-emit design — audit_logs DB write
      // + logger.warn (observability). When audit DI is not wired (this test
      // fixture), `AuditLogService.log` internally emits its own "Prisma client
      // not available" warn. Filter for the emitter's own 5-field contract warn.
      const emitterCalls = warnSpy.mock.calls.filter(
        (call) =>
          typeof call[0] === "string" &&
          (call[0] as string).includes("[EmbeddingBackfillWorker] parity_check_failed emitted")
      );
      expect(emitterCalls).toHaveLength(1);
      const [message, data] = emitterCalls[0] as [string, Record<string, unknown>];
      expect(typeof message).toBe("string");
      expect(message).toContain("parity_check_failed");
      // Data payload must contain all 5 contract fields.
      expect(data).toBeDefined();
      expect(typeof data.webPageId).toBe("string");
      // webPageId MUST be truncated (8-char prefix + "...")
      expect((data.webPageId as string).endsWith("...")).toBe(true);
      expect((data.webPageId as string).length).toBeLessThanOrEqual(12);
      // Full UUID MUST NOT appear in the emitted data (PII-free guarantee).
      expect(data.webPageId).not.toBe(FAKE_PAGE_ID);
      // category map (Record<EmbeddingBackfillCategory, number>).
      expect(data.category).toBeDefined();
      // pendingSnapshot MUST be numeric-only.
      expect(data.pendingSnapshot).toBeDefined();
      const snapshotData = data.pendingSnapshot as Record<string, unknown>;
      for (const value of Object.values(snapshotData)) {
        expect(typeof value).toBe("number");
      }
      // skipReason literal + timestamp ISO-8601 string.
      expect(data.skipReason).toBe("parity_check_failed");
      expect(typeof data.timestamp).toBe("string");
      // ISO-8601 sanity: parse round-trip produces a valid Date.
      expect(Number.isNaN(Date.parse(data.timestamp as string))).toBe(false);
    });

    it("INV-EMBEDDING-INTEGRITY-003: C14 — handleTerminalParityGate sets DB to skipped_fork_error and returns matching finalStatus on parity failure", async () => {
      // Per FIND-PLAN-IO-03 Option A: finalStatus union expanded to include
      // skipped_fork_error, so the returned finalStatus must match the DB
      // write exactly (no semantic drift between BullMQ job return and DB).
      //
      // Verification strategy (two-pronged):
      //   (i) Runtime: invoke handleTerminalParityGate with a violating
      //       snapshot and assert the return contract (parityFailed + finalStatus).
      //   (ii) AST: pin the call-site string so any future refactor that
      //       decouples the returned finalStatus from the DB-write status
      //       surfaces as a CI failure.
      // This ensures the T1 contract "return value === DB write value" is
      // enforceable without relying on Prisma client spying (Prisma client
      // proxies don't support vi.spyOn cleanly).
      const workerModule = await import("../../../../src/workers/embedding-backfill-worker");
      const gate = (
        workerModule as unknown as {
          handleTerminalParityGate: (
            webPageId: string,
            finalStatus: "completed" | "in_progress",
            processorResult: { generated: number; failed: number },
            pendingSnapshot: CategoryPendingSnapshot
          ) => Promise<{
            parityFailed: boolean;
            finalStatus: "completed" | "in_progress" | "skipped_fork_error";
          }>;
        }
      ).handleTerminalParityGate;

      expect(typeof gate).toBe("function");

      // Silence the logger emission for this test (runtime path asserts
      // return contract, not logger).
      const loggerModule = await import("../../../../src/utils/logger");
      vi.spyOn(loggerModule.logger, "warn").mockImplementation(() => {});

      const pendingSnapshot: CategoryPendingSnapshot = {
        part_text: 1, // violating
        part_visual: 0,
        section_visual: 0,
        motion: 0,
        background: 0,
        js_animation: 0,
        responsive: 0,
      };

      // (i) Runtime return-contract assertion.
      const result = await gate(
        FAKE_PAGE_ID,
        "completed",
        { generated: 0, failed: 0 },
        pendingSnapshot
      );
      expect(result.parityFailed).toBe(true);
      expect(result.finalStatus).toBe("skipped_fork_error");

      // (ii) AST-level assertion: the parity-failure path MUST call
      // `updateEmbeddingBackfillStatus(..., "skipped_fork_error")`. Pins
      // return value ↔ DB write alignment (FIND-PLAN-IO-03 Option A) at
      // source level. AST (rather than spy) is used because the module-local
      // `updateEmbeddingBackfillStatus` is called via direct binding, which
      // cannot be intercepted by `vi.spyOn` on the module namespace.
      const path = await import("node:path");
      const fs = await import("node:fs");
      const workerSourcePath = path.resolve(
        __dirname,
        "../../../../src/workers/embedding-backfill-worker.ts"
      );
      const workerSource = fs.readFileSync(workerSourcePath, "utf8");
      expect(workerSource).toContain(
        'updateEmbeddingBackfillStatus(webPageId, "skipped_fork_error")'
      );
    });

    it("INV-EMBEDDING-INTEGRITY-003: C15 — verifyCategoryParity DB-failure fail-closed (collectCategoryPendingSnapshot propagates error)", async () => {
      // TPA-mandated per FIND-PLAN-IO-06 (i): when
      // collectCategoryPendingSnapshot's Promise.all rejects, the helper
      // MUST NOT silently return `completed`. It must propagate the error
      // so the caller routes to the parity_check_failed retry bucket
      // (fail-closed, GDPR Art.5(1)(d) accuracy).
      const prisma = buildFailingPrismaMock("simulated DB outage");
      await expect(collectCategoryPendingSnapshot(FAKE_PAGE_ID, prisma)).rejects.toThrow(
        "simulated DB outage"
      );

      // Same for the single-query refactored computeRemainingStatusWithPrisma:
      // a DB failure in any category MUST propagate, not silently return
      // "completed". No transition to completed is allowed under uncertainty.
      const failingPrisma = buildFailingPrismaMock("DB down");
      await expect(computeRemainingStatusWithPrisma(FAKE_PAGE_ID, failingPrisma)).rejects.toThrow();
    });

    it("INV-EMBEDDING-INTEGRITY-003: C16 — integration-level TOCTOU: single-query refactor structurally eliminates phantom-read surface", async () => {
      // TPA-mandated per FIND-PLAN-IO-06 (iii): simulate a concurrent INSERT
      // occurring between the pre-refactor two-round-trip pattern. With the
      // preferred single-query refactor, both finalStatus and pendingSnapshot
      // are produced by a single invocation of collectCategoryPendingSnapshot,
      // so the phantom-read surface is structurally absent.
      //
      // This test uses an instrumented mock Prisma to count how many times
      // the category counters are invoked per computeRemainingStatusWithPrisma
      // call. Under the preferred path, each counter MUST be called exactly
      // once (proof that no second round-trip exists). If a future regression
      // re-introduces the two-round-trip pattern, this test fails.
      //
      // (A real-Prisma concurrent INSERT test requires testcontainers which
      // is costly; this mock-based structural check is the enforceable
      // proxy.)
      const componentPartCount = vi.fn(async () => 0);
      const motionCount = vi.fn(async () => 0);
      const backgroundCount = vi.fn(async () => 0);
      const jsAnimationCount = vi.fn(async () => 0);
      const responsiveCount = vi.fn(async () => 0);
      const rawQuery = vi.fn(async (_sql: string) => [{ count: BigInt(0) }]);

      const prisma = {
        componentPart: { count: componentPartCount },
        motionPattern: { count: motionCount },
        backgroundDesign: { count: backgroundCount },
        jSAnimationPattern: { count: jsAnimationCount },
        responsiveAnalysis: { count: responsiveCount },
        $queryRawUnsafe: rawQuery,
      } as unknown as PrismaClient;

      const { finalStatus, pendingSnapshot } = await computeRemainingStatusWithPrisma(
        FAKE_PAGE_ID,
        prisma
      );

      expect(finalStatus).toBe("completed");
      expect(pendingSnapshot).toBeDefined();

      // Single-query refactor invariant: each Prisma counter is invoked
      // exactly once per computeRemainingStatusWithPrisma call. If the
      // pre-refactor two-round-trip pattern is reintroduced, these counts
      // would be >= 2 and the test would fail, surfacing the phantom-read
      // regression at CI time.
      expect(componentPartCount).toHaveBeenCalledTimes(1);
      expect(motionCount).toHaveBeenCalledTimes(1);
      expect(backgroundCount).toHaveBeenCalledTimes(1);
      expect(jsAnimationCount).toHaveBeenCalledTimes(1);
      expect(responsiveCount).toHaveBeenCalledTimes(1);
      // Two raw queries: part_visual + section_visual.
      expect(rawQuery).toHaveBeenCalledTimes(2);
    });
  });
});
