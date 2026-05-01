// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * repair-page-analyze script tests (v0.4.0 PR7e-α bug⑤)
 *
 * Covers:
 *   - CLI arg parsing (dry-run default, --confirm --yes)
 *   - Validation guards: operator missing / confirm without yes / production
 *   - Active-lock pre-flight (SEC 7)
 *   - Idempotency key determinism (SEC MED-4)
 *   - Stale candidate fetch WHERE clause
 *   - CAS + enqueue happy path + cas_lost path
 *   - No persisted screenshot → skipped_no_screenshot
 *   - Dry-run mode does NOT mutate DB or enqueue
 *   - Overflow detection (REFTRIX_REPAIR_MAX_PAGES)
 *   - audit_logs call shape (LCC A-1)
 *
 * Mock-based unit tests — full DB fixture integration is exercised in CI via
 * Docker-compose (see docs/specs/current-architecture.md).
 *
 * @module tests/scripts/repair-page-analyze
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted: mocks must not reference unhoisted top-level variables.
const {
  mockWebPageFindMany,
  mockWebPageUpdateMany,
  mockAddEmbeddingBackfillJob,
  mockCreateQueue,
  mockAuditLog,
  mockProbeExistingLock,
} = vi.hoisted(() => ({
  mockWebPageFindMany: vi.fn<[], Promise<unknown[]>>(async () => []),
  mockWebPageUpdateMany: vi.fn<[], Promise<{ count: number }>>(async () => ({ count: 1 })),
  // PR-D-6 Phase 2: mock migrated from legacy `addEmbeddingBackfillJob` to
  // `addEmbeddingBackfillJobWithGuard`. Return the `EnqueueResult` discriminated
  // union `enqueued_new` variant (happy path) — the repair script reads
  // `.outcome` / `.collision` via the 6-variant union.
  mockAddEmbeddingBackfillJob: vi.fn(async () => ({
    outcome: "enqueued_new" as const,
    jobId: "mock-job-id",
    collision: null,
  })),
  mockCreateQueue: vi.fn(() => ({
    close: vi.fn(async () => undefined),
  })),
  mockAuditLog: vi.fn(async () => undefined),
  mockProbeExistingLock: vi.fn(
    async (): Promise<
      | { unavailable: false; exists: false }
      | { unavailable: false; exists: true; nonce: string }
      | { unavailable: true; error: string }
    > => ({ unavailable: false, exists: false })
  ),
}));

vi.mock("@reftrixmcp/database", () => ({
  PrismaClient: vi.fn().mockImplementation(() => ({
    webPage: {
      findMany: mockWebPageFindMany,
      updateMany: mockWebPageUpdateMany,
    },
    $disconnect: vi.fn(async () => undefined),
  })),
}));

vi.mock("../../src/queues/embedding-backfill-queue", async () => {
  const actual = await vi.importActual<typeof import("../../src/queues/embedding-backfill-queue")>(
    "../../src/queues/embedding-backfill-queue"
  );
  return {
    ...actual,
    createEmbeddingBackfillQueue: mockCreateQueue,
    // PR-D-6 Phase 2: migrate legacy `addEmbeddingBackfillJob` → with-guard SSOT.
    // The repair script imports `addEmbeddingBackfillJobWithGuard`; the legacy
    // export is preserved via `...actual` for any residual callers.
    addEmbeddingBackfillJobWithGuard: mockAddEmbeddingBackfillJob,
  };
});

vi.mock("../../src/services/audit-log.service", () => ({
  getAuditLogService: () => ({ log: mockAuditLog }),
}));

vi.mock("../../src/services/worker-active-lock.service", () => ({
  WorkerActiveLockService: vi.fn().mockImplementation(() => ({
    probeExistingLock: mockProbeExistingLock,
    close: vi.fn(async () => undefined),
  })),
}));

import {
  EXIT_ACTIVE_LOCK,
  EXIT_USAGE_ERROR,
  buildIdempotencyKey,
  fetchStaleCandidates,
  parseRepairArgs,
  probeActiveLock,
  runPageAnalyzeRepair,
  validateCliArgs,
  type RepairCliArgs,
} from "../../scripts/repair-page-analyze";
import type { PrismaClient } from "@reftrixmcp/database";

function baseArgs(overrides: Partial<RepairCliArgs> = {}): RepairCliArgs {
  return {
    dryRun: true,
    confirm: false,
    yes: false,
    operator: "pipeline-engineer",
    maxPages: 100,
    ...overrides,
  };
}

function makePrismaStub(): PrismaClient {
  return {
    webPage: {
      findMany: mockWebPageFindMany,
      updateMany: mockWebPageUpdateMany,
    },
    $disconnect: vi.fn(async () => undefined),
  } as unknown as PrismaClient;
}

describe("repair-page-analyze (v0.4.0 PR7e-α bug⑤)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProbeExistingLock.mockResolvedValue({ unavailable: false, exists: false });
    mockWebPageFindMany.mockResolvedValue([]);
    mockWebPageUpdateMany.mockResolvedValue({ count: 1 });
  });

  // ==========================================================================
  // CLI parsing
  // ==========================================================================
  describe("parseRepairArgs", () => {
    it("defaults to dry-run when --confirm is absent", () => {
      const args = parseRepairArgs(["node", "script", "--operator=tkmd"]);
      expect(args.dryRun).toBe(true);
      expect(args.confirm).toBe(false);
      expect(args.operator).toBe("tkmd");
    });

    it("requires --confirm AND --yes for mutation mode", () => {
      const args = parseRepairArgs(["node", "script", "--operator=tkmd", "--confirm", "--yes"]);
      expect(args.dryRun).toBe(false);
      expect(args.confirm).toBe(true);
      expect(args.yes).toBe(true);
    });

    it("respects REFTRIX_REPAIR_MAX_PAGES override", () => {
      process.env["REFTRIX_REPAIR_MAX_PAGES"] = "25";
      try {
        const args = parseRepairArgs(["node", "script", "--operator=tkmd"]);
        expect(args.maxPages).toBe(25);
      } finally {
        delete process.env["REFTRIX_REPAIR_MAX_PAGES"];
      }
    });
  });

  // ==========================================================================
  // validateCliArgs (SEC 1 / 2 / 3 / 4)
  // ==========================================================================
  describe("validateCliArgs", () => {
    it("rejects missing --operator", () => {
      const err = validateCliArgs(baseArgs({ operator: "" }));
      expect(err?.code).toBe("operator_missing");
    });

    it("rejects --confirm without --yes", () => {
      const err = validateCliArgs(baseArgs({ confirm: true, yes: false, dryRun: false }));
      expect(err?.code).toBe("confirm_without_yes");
    });

    it("rejects production unless REFTRIX_REPAIR_ALLOW_PRODUCTION=true", () => {
      const originalEnv = process.env["NODE_ENV"];
      process.env["NODE_ENV"] = "production";
      try {
        const err = validateCliArgs(baseArgs());
        expect(err?.code).toBe("production_gated");
      } finally {
        if (originalEnv === undefined) {
          delete process.env["NODE_ENV"];
        } else {
          process.env["NODE_ENV"] = originalEnv;
        }
      }
    });

    it("accepts production when REFTRIX_REPAIR_ALLOW_PRODUCTION=true", () => {
      const originalEnv = process.env["NODE_ENV"];
      process.env["NODE_ENV"] = "production";
      process.env["REFTRIX_REPAIR_ALLOW_PRODUCTION"] = "true";
      try {
        expect(validateCliArgs(baseArgs())).toBeNull();
      } finally {
        delete process.env["REFTRIX_REPAIR_ALLOW_PRODUCTION"];
        if (originalEnv === undefined) {
          delete process.env["NODE_ENV"];
        } else {
          process.env["NODE_ENV"] = originalEnv;
        }
      }
    });
  });

  // ==========================================================================
  // Idempotency key (SEC MED-4)
  // ==========================================================================
  describe("buildIdempotencyKey", () => {
    it("produces a deterministic sha256 hex digest", () => {
      const k1 = buildIdempotencyKey("page-1", "op", "run-1");
      const k2 = buildIdempotencyKey("page-1", "op", "run-1");
      expect(k1).toBe(k2);
      expect(k1).toMatch(/^[0-9a-f]{64}$/);
    });

    it("differs when any input differs", () => {
      const k1 = buildIdempotencyKey("page-1", "op", "run-1");
      const k2 = buildIdempotencyKey("page-2", "op", "run-1");
      const k3 = buildIdempotencyKey("page-1", "op-other", "run-1");
      expect(new Set([k1, k2, k3]).size).toBe(3);
    });
  });

  // ==========================================================================
  // Active-lock probe (SEC 7)
  // ==========================================================================
  describe("probeActiveLock", () => {
    it("blocks when an existing lock is present", async () => {
      mockProbeExistingLock.mockResolvedValueOnce({
        unavailable: false,
        exists: true,
        nonce: "abc",
      });
      const result = await probeActiveLock({ probeExistingLock: mockProbeExistingLock });
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe("active_worker_lock_present");
    });

    it("passes when no lock is present", async () => {
      const result = await probeActiveLock({ probeExistingLock: mockProbeExistingLock });
      expect(result.blocked).toBe(false);
    });

    it("fails-open when Redis is unavailable (SEC M-1 alignment)", async () => {
      mockProbeExistingLock.mockResolvedValueOnce({
        unavailable: true,
        error: "ECONNREFUSED",
      });
      const result = await probeActiveLock({ probeExistingLock: mockProbeExistingLock });
      expect(result.blocked).toBe(false);
      expect(result.reason).toBe("redis_unreachable_fail_open");
    });
  });

  // ==========================================================================
  // fetchStaleCandidates
  // ==========================================================================
  describe("fetchStaleCandidates", () => {
    it("queries in_progress / skipped_memory_pressure / skipped_fork_error / failed and updatedAt < 1h", async () => {
      await fetchStaleCandidates(makePrismaStub(), 100);
      expect(mockWebPageFindMany).toHaveBeenCalledTimes(1);
      const args = (mockWebPageFindMany.mock.calls[0]?.[0] ?? {}) as {
        where: {
          embeddingBackfillStatus: { in: string[] };
          updatedAt: { lt: Date };
          OR: unknown[];
        };
        take: number;
      };
      // PR7e-α fix-up: 'failed' added to rescue Stripe-class stale records (TPA audit finding)
      expect(args.where.embeddingBackfillStatus.in).toEqual([
        "in_progress",
        "skipped_memory_pressure",
        "skipped_fork_error",
        "failed",
      ]);
      expect(args.where.OR).toHaveLength(2);
      expect(args.take).toBe(101); // maxPages + 1 for overflow detection
    });

    it("returns rows with embeddingBackfillStatus='failed' (PR7e-α fix-up, Stripe-class)", async () => {
      mockWebPageFindMany.mockResolvedValueOnce([
        {
          id: "019d92e7-eedf-768d-8cca-96ff50fe09a5",
          url: "https://stripe.com",
          embeddingBackfillStatus: "failed",
          embeddingBackfillStartedAt: null,
          updatedAt: new Date("2026-04-12T00:00:00Z"),
          screenshotStoragePath: "/tmp/reftrix-screenshots/phase5/stripe.png",
        },
      ]);
      const candidates = await fetchStaleCandidates(makePrismaStub(), 100);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.embeddingBackfillStatus).toBe("failed");
      expect(candidates[0]?.webPageId).toBe("019d92e7-eedf-768d-8cca-96ff50fe09a5");
    });
  });

  // ==========================================================================
  // runPageAnalyzeRepair — dry-run
  // ==========================================================================
  describe("runPageAnalyzeRepair (dry-run)", () => {
    it("does NOT call updateMany or addEmbeddingBackfillJob", async () => {
      mockWebPageFindMany.mockResolvedValueOnce([
        {
          id: "019bc111-2222-3333-4444-555555555555",
          url: "https://stripe.com",
          embeddingBackfillStatus: "in_progress",
          embeddingBackfillStartedAt: null,
          updatedAt: new Date("2026-04-12T00:00:00Z"),
          screenshotStoragePath: "/tmp/reftrix-screenshots/phase5/abc.png",
        },
      ]);
      const result = await runPageAnalyzeRepair(makePrismaStub(), null, baseArgs());
      expect(result.dryRun).toBe(true);
      expect(result.detected).toBe(1);
      expect(mockWebPageUpdateMany).not.toHaveBeenCalled();
      expect(mockAddEmbeddingBackfillJob).not.toHaveBeenCalled();
    });

    it("writes the dry-run audit marker", async () => {
      mockWebPageFindMany.mockResolvedValueOnce([]);
      await runPageAnalyzeRepair(makePrismaStub(), null, baseArgs());
      expect(mockAuditLog).toHaveBeenCalledTimes(1);
      const entry = mockAuditLog.mock.calls[0]?.[0] as { action: string; actor: string };
      expect(entry.action).toBe("embedding_backfill_repair_dryrun");
      expect(entry.actor).toBe("repair-script:pipeline-engineer");
    });
  });

  // ==========================================================================
  // runPageAnalyzeRepair — confirm path
  // ==========================================================================
  describe("runPageAnalyzeRepair (confirm)", () => {
    const confirmArgs = baseArgs({ dryRun: false, confirm: true, yes: true });
    const makeCandidate = (overrides: Partial<Record<string, unknown>> = {}) => ({
      id: "019bc111-2222-3333-4444-555555555555",
      url: "https://stripe.com",
      embeddingBackfillStatus: "in_progress",
      embeddingBackfillStartedAt: null,
      updatedAt: new Date("2026-04-12T00:00:00Z"),
      screenshotStoragePath: "/tmp/reftrix-screenshots/phase5/abc.png",
      ...overrides,
    });

    it("enqueues part_visual + section_visual when CAS succeeds", async () => {
      mockWebPageFindMany.mockResolvedValueOnce([makeCandidate()]);
      mockWebPageUpdateMany.mockResolvedValueOnce({ count: 1 });
      const queue = { close: vi.fn(async () => undefined) } as unknown as ReturnType<
        typeof mockCreateQueue
      >;
      const result = await runPageAnalyzeRepair(makePrismaStub(), queue as never, confirmArgs);
      expect(result.perPage).toHaveLength(1);
      expect(result.perPage[0]?.status).toBe("enqueued");
      expect(result.perPage[0]?.enqueuedCategories).toEqual(["part_visual", "section_visual"]);
      expect(mockAddEmbeddingBackfillJob).toHaveBeenCalledTimes(2);
      // Per-page audit entry recorded.
      const perPageAudits = mockAuditLog.mock.calls.filter(
        (c) => (c[0] as { action: string }).action === "embedding_backfill_repair"
      );
      expect(perPageAudits).toHaveLength(1);
    });

    it("enqueues failed-status rows via CAS (PR7e-α fix-up, Stripe-class rescue)", async () => {
      mockWebPageFindMany.mockResolvedValueOnce([
        makeCandidate({
          id: "019d92e7-eedf-768d-8cca-96ff50fe09a5",
          embeddingBackfillStatus: "failed",
        }),
      ]);
      mockWebPageUpdateMany.mockResolvedValueOnce({ count: 1 });
      const queue = { close: vi.fn(async () => undefined) } as unknown as ReturnType<
        typeof mockCreateQueue
      >;
      const result = await runPageAnalyzeRepair(makePrismaStub(), queue as never, confirmArgs);
      expect(result.perPage).toHaveLength(1);
      expect(result.perPage[0]?.status).toBe("enqueued");
      // Verify CAS WHERE includes 'failed'
      const casCall = mockWebPageUpdateMany.mock.calls[0]?.[0] as {
        where: { embeddingBackfillStatus: { in: string[] } };
      };
      expect(casCall.where.embeddingBackfillStatus.in).toContain("failed");
    });

    it("returns cas_lost when updateMany count=0 (race condition)", async () => {
      mockWebPageFindMany.mockResolvedValueOnce([makeCandidate()]);
      mockWebPageUpdateMany.mockResolvedValueOnce({ count: 0 });
      const queue = { close: vi.fn(async () => undefined) } as unknown;
      const result = await runPageAnalyzeRepair(makePrismaStub(), queue as never, confirmArgs);
      expect(result.perPage[0]?.status).toBe("cas_lost");
      expect(mockAddEmbeddingBackfillJob).not.toHaveBeenCalled();
    });

    it("skips rows without a persisted screenshot", async () => {
      mockWebPageFindMany.mockResolvedValueOnce([makeCandidate({ screenshotStoragePath: null })]);
      const queue = { close: vi.fn(async () => undefined) } as unknown;
      const result = await runPageAnalyzeRepair(makePrismaStub(), queue as never, confirmArgs);
      expect(result.perPage[0]?.status).toBe("skipped_no_screenshot");
      expect(mockWebPageUpdateMany).not.toHaveBeenCalled();
      expect(mockAddEmbeddingBackfillJob).not.toHaveBeenCalled();
    });

    it("records a per-page audit entry with LCC-A1 schema fields", async () => {
      mockWebPageFindMany.mockResolvedValueOnce([makeCandidate()]);
      mockWebPageUpdateMany.mockResolvedValueOnce({ count: 1 });
      const queue = { close: vi.fn(async () => undefined) } as unknown;
      await runPageAnalyzeRepair(makePrismaStub(), queue as never, confirmArgs);
      const perPageEntry = mockAuditLog.mock.calls.find(
        (c) => (c[0] as { action: string }).action === "embedding_backfill_repair"
      )?.[0] as {
        action: string;
        actor: string;
        targetType: string;
        details: Record<string, unknown>;
      };
      expect(perPageEntry.targetType).toBe("web_page");
      expect(perPageEntry.details.bug_reference).toBe("PR7e-Ω bug ⑤");
      expect(perPageEntry.details.remediation_pr).toBe("PR7e-α");
      expect(perPageEntry.details.idempotency_key).toMatch(/^[0-9a-f]{64}$/);
      expect(perPageEntry.details.repair_reason).toBe("missing_audit_entry_due_to_bug_PR7e_bug_5");
    });
  });

  // ==========================================================================
  // Overflow detection (SEC 2 / EXIT_MAX_PAGES_EXCEEDED)
  // ==========================================================================
  describe("overflow detection", () => {
    it("flags overflow when candidate count exceeds maxPages", async () => {
      // Return maxPages + 1 rows to trip the overflow sentinel.
      const rows = Array.from({ length: 3 }, (_, i) => ({
        id: `019bc000-0000-0000-0000-00000000000${i}`,
        url: "https://example.com",
        embeddingBackfillStatus: "in_progress",
        embeddingBackfillStartedAt: null,
        updatedAt: new Date("2026-04-12T00:00:00Z"),
        screenshotStoragePath: null,
      }));
      mockWebPageFindMany.mockResolvedValueOnce(rows);
      const result = await runPageAnalyzeRepair(makePrismaStub(), null, baseArgs({ maxPages: 2 }));
      expect(result.overflow).toBe(true);
      expect(result.detected).toBe(2); // clamped to maxPages
    });
  });

  // ==========================================================================
  // Idempotency guarantees
  // ==========================================================================
  describe("idempotency", () => {
    it("produces the same idempotency_key for same (webPageId, operator, runId)", () => {
      const k1 = buildIdempotencyKey("p", "op", "run");
      const k2 = buildIdempotencyKey("p", "op", "run");
      expect(k1).toBe(k2);
    });
  });

  // ==========================================================================
  // Sanity: exported exit codes are stable
  // ==========================================================================
  describe("exit code sentinels", () => {
    it("matches the SEC-aligned values", () => {
      expect(EXIT_USAGE_ERROR).toBe(2);
      expect(EXIT_ACTIVE_LOCK).toBe(3);
    });
  });
});
