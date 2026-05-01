// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * force-reconcile-backfill.ts — Unit & Integration Tests (v0.4.0 PR7e-β4 PR1)
 *
 * Stripe 再分析で onnxruntime-node 1.21.0 NAPI HandleScope FATAL により
 * EmbeddingBackfillWorker が死亡し、254 part_visual jobs が in_progress で stuck
 * したケースを救済する CLI のテスト。
 *
 * Tests for the force-reconcile CLI that releases stuck `in_progress` rows
 * (e.g. 254 part_visual jobs after the Stripe NAPI HandleScope FATAL crash).
 *
 * カバレッジ / Coverage:
 *   - parseArgs defaults / overrides / invalid enum errors
 *   - findStuckCandidates: SQL filter (status, olderThanMs, webPageId)
 *   - applyForceRelease: CAS guard (skip rows whose status changed mid-run)
 *   - runForceReconcile dry-run / confirm
 *   - audit_logs recording in both modes (PR7d-3 pattern)
 *   - --web-page-id filter scopes the SELECT
 *
 * Note: This file uses Prisma mocks (no live DB). The "integration" suffix is
 * for naming consistency with `repair-orphaned-backfill-records.test.ts` —
 * actual DB integration is covered by `repair-page-analyze.integration.test.ts`
 * and is gated on DATABASE_URL.
 *
 * @module tests/scripts/force-reconcile-backfill.integration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EmbeddingBackfillStatus } from "@prisma/client";

import {
  parseArgs,
  findStuckCandidates,
  applyForceRelease,
  runForceReconcile,
  type ForceReconcilePrismaClient,
} from "../../scripts/force-reconcile-backfill";

import {
  setAuditLogPrismaClientFactory,
  resetAuditLogPrismaClientFactory,
  resetAuditLogService,
  type AuditLogPrismaClient,
} from "../../src/services/audit-log.service";

// ============================================================================
// Helpers
// ============================================================================

interface MockRow {
  id: string;
  embeddingBackfillStatus: EmbeddingBackfillStatus;
  embeddingBackfillStartedAt: Date | null;
  embeddingBackfillRetryCount: number;
}

function makeMockPrisma(rows: MockRow[]): ForceReconcilePrismaClient & {
  webPage: {
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
} {
  const db = [...rows];
  return {
    webPage: {
      findMany: vi.fn(
        async (args: {
          where: Record<string, unknown>;
          select: Record<string, true>;
          take: number;
        }) => {
          // Apply filters: status, startedAt < cutoff, optional id
          const status = args.where.embeddingBackfillStatus;
          const startedAtFilter = args.where.embeddingBackfillStartedAt as
            | { lt?: Date }
            | undefined;
          const idFilter = args.where.id as string | undefined;
          const filtered = db.filter((r) => {
            if (status !== undefined && r.embeddingBackfillStatus !== status) return false;
            if (
              startedAtFilter?.lt !== undefined &&
              (!r.embeddingBackfillStartedAt || r.embeddingBackfillStartedAt >= startedAtFilter.lt)
            ) {
              return false;
            }
            if (idFilter !== undefined && r.id !== idFilter) return false;
            return true;
          });
          return filtered.slice(0, args.take).map((r) => ({
            id: r.id,
            embeddingBackfillStatus: r.embeddingBackfillStatus,
            embeddingBackfillStartedAt: r.embeddingBackfillStartedAt,
            embeddingBackfillRetryCount: r.embeddingBackfillRetryCount,
          }));
        }
      ),
      updateMany: vi.fn(
        async (args: {
          where: { id?: { in: string[] }; embeddingBackfillStatus?: EmbeddingBackfillStatus };
          data: {
            embeddingBackfillStatus: EmbeddingBackfillStatus;
            embeddingBackfillStartedAt: Date | null;
          };
        }) => {
          const idsIn = args.where.id?.in ?? [];
          const statusGuard = args.where.embeddingBackfillStatus;
          let count = 0;
          for (const r of db) {
            if (!idsIn.includes(r.id)) continue;
            // CAS guard: only update if status still matches
            if (statusGuard !== undefined && r.embeddingBackfillStatus !== statusGuard) continue;
            r.embeddingBackfillStatus = args.data.embeddingBackfillStatus;
            r.embeddingBackfillStartedAt = args.data.embeddingBackfillStartedAt;
            count += 1;
          }
          return { count };
        }
      ),
    },
  };
}

const HOUR_MS = 3_600_000;

function pastDate(msAgo: number): Date {
  return new Date(Date.now() - msAgo);
}

// ============================================================================
// parseArgs tests
// ============================================================================

describe("force-reconcile-backfill parseArgs (v0.4.0 PR7e-β4 PR1)", () => {
  it("defaults to dry-run when no flags", () => {
    const args = parseArgs(["node", "force-reconcile.ts"]);
    expect(args.dryRun).toBe(true);
    expect(args.confirm).toBe(false);
    expect(args.statusFrom).toBe("in_progress");
    expect(args.statusTo).toBe("failed");
    expect(args.skipReason).toBe("dispatch_phase_failed");
    expect(args.olderThanMs).toBe(HOUR_MS);
    expect(args.maxRecords).toBe(100);
  });

  it("--confirm switches off dry-run", () => {
    const args = parseArgs(["node", "force-reconcile.ts", "--confirm"]);
    expect(args.confirm).toBe(true);
    expect(args.dryRun).toBe(false);
  });

  it("--dry-run + --confirm keeps dry-run (explicit safety)", () => {
    const args = parseArgs(["node", "force-reconcile.ts", "--dry-run", "--confirm"]);
    expect(args.dryRun).toBe(true);
    expect(args.confirm).toBe(true);
  });

  it("parses --web-page-id", () => {
    const args = parseArgs([
      "node",
      "force-reconcile.ts",
      "--web-page-id=00000000-1111-7777-aaaa-bbbbbbbbbbbb",
    ]);
    expect(args.webPageId).toBe("00000000-1111-7777-aaaa-bbbbbbbbbbbb");
  });

  it("parses --category=part_visual", () => {
    const args = parseArgs(["node", "force-reconcile.ts", "--category=part_visual"]);
    expect(args.category).toBe("part_visual");
  });

  it("rejects invalid --category", () => {
    expect(() => parseArgs(["node", "force-reconcile.ts", "--category=invalid_cat"])).toThrow(
      /Invalid --category/
    );
  });

  it("rejects invalid --status-from", () => {
    expect(() => parseArgs(["node", "force-reconcile.ts", "--status-from=garbage"])).toThrow(
      /Invalid --status-from/
    );
  });

  it("rejects invalid --status-to", () => {
    expect(() => parseArgs(["node", "force-reconcile.ts", "--status-to=garbage"])).toThrow(
      /Invalid --status-to/
    );
  });

  it("rejects invalid --skip-reason", () => {
    expect(() => parseArgs(["node", "force-reconcile.ts", "--skip-reason=garbage"])).toThrow(
      /Invalid --skip-reason/
    );
  });

  it("parses --older-than-ms numeric value", () => {
    const args = parseArgs(["node", "force-reconcile.ts", "--older-than-ms=1800000"]);
    expect(args.olderThanMs).toBe(1_800_000);
  });

  it("rejects --older-than-ms=0 (must be positive)", () => {
    expect(() => parseArgs(["node", "force-reconcile.ts", "--older-than-ms=0"])).toThrow(
      /Invalid --older-than-ms/
    );
  });

  it("parses --max-records", () => {
    const args = parseArgs(["node", "force-reconcile.ts", "--max-records=50"]);
    expect(args.maxRecords).toBe(50);
  });

  it("parses --status-from=skipped_fork_error and --status-to=queued (re-enqueue scenario)", () => {
    const args = parseArgs([
      "node",
      "force-reconcile.ts",
      "--status-from=skipped_fork_error",
      "--status-to=queued",
    ]);
    expect(args.statusFrom).toBe("skipped_fork_error");
    expect(args.statusTo).toBe("queued");
  });
});

// ============================================================================
// findStuckCandidates tests
// ============================================================================

describe("force-reconcile-backfill findStuckCandidates (v0.4.0 PR7e-β4 PR1)", () => {
  it("returns rows whose status matches AND startedAt is older than cutoff", async () => {
    const rows: MockRow[] = [
      {
        id: "11111111-aaaa-7777-aaaa-bbbbbbbbbbbb",
        embeddingBackfillStatus: "in_progress",
        embeddingBackfillStartedAt: pastDate(2 * HOUR_MS), // 2h ago — stuck
        embeddingBackfillRetryCount: 0,
      },
      {
        id: "22222222-aaaa-7777-aaaa-bbbbbbbbbbbb",
        embeddingBackfillStatus: "in_progress",
        embeddingBackfillStartedAt: pastDate(10 * 60 * 1000), // 10min ago — fresh
        embeddingBackfillRetryCount: 0,
      },
    ];
    const prisma = makeMockPrisma(rows);
    const result = await findStuckCandidates(prisma, {
      statusFrom: "in_progress",
      olderThanMs: HOUR_MS,
      maxRecords: 100,
    });
    expect(result).toHaveLength(1);
    expect(result[0].webPageId).toBe("11111111-aaaa-7777-aaaa-bbbbbbbbbbbb");
  });

  it("scopes to a single row when webPageId is provided", async () => {
    const rows: MockRow[] = [
      {
        id: "aaaaaaaa-bbbb-7777-aaaa-bbbbbbbbbbbb",
        embeddingBackfillStatus: "in_progress",
        embeddingBackfillStartedAt: pastDate(2 * HOUR_MS),
        embeddingBackfillRetryCount: 0,
      },
      {
        id: "bbbbbbbb-cccc-7777-aaaa-bbbbbbbbbbbb",
        embeddingBackfillStatus: "in_progress",
        embeddingBackfillStartedAt: pastDate(2 * HOUR_MS),
        embeddingBackfillRetryCount: 0,
      },
    ];
    const prisma = makeMockPrisma(rows);
    const result = await findStuckCandidates(prisma, {
      statusFrom: "in_progress",
      olderThanMs: HOUR_MS,
      maxRecords: 100,
      webPageId: "aaaaaaaa-bbbb-7777-aaaa-bbbbbbbbbbbb",
    });
    expect(result).toHaveLength(1);
    expect(result[0].webPageId).toBe("aaaaaaaa-bbbb-7777-aaaa-bbbbbbbbbbbb");
  });

  it("respects maxRecords cap", async () => {
    const rows: MockRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: `${i}${i}${i}${i}${i}${i}${i}${i}-aaaa-7777-aaaa-bbbbbbbbbbbb`,
      embeddingBackfillStatus: "in_progress" as EmbeddingBackfillStatus,
      embeddingBackfillStartedAt: pastDate(2 * HOUR_MS),
      embeddingBackfillRetryCount: 0,
    }));
    const prisma = makeMockPrisma(rows);
    const result = await findStuckCandidates(prisma, {
      statusFrom: "in_progress",
      olderThanMs: HOUR_MS,
      maxRecords: 2,
    });
    expect(result).toHaveLength(2);
  });
});

// ============================================================================
// applyForceRelease tests (CAS guard)
// ============================================================================

describe("force-reconcile-backfill applyForceRelease (v0.4.0 PR7e-β4 PR1)", () => {
  it("transitions matching rows from statusFrom to statusTo and clears startedAt", async () => {
    const rows: MockRow[] = [
      {
        id: "11111111-aaaa-7777-aaaa-bbbbbbbbbbbb",
        embeddingBackfillStatus: "in_progress",
        embeddingBackfillStartedAt: pastDate(2 * HOUR_MS),
        embeddingBackfillRetryCount: 0,
      },
    ];
    const prisma = makeMockPrisma(rows);
    const count = await applyForceRelease(
      prisma,
      {
        dryRun: false,
        confirm: true,
        statusFrom: "in_progress",
        statusTo: "failed",
        skipReason: "dispatch_phase_failed",
        olderThanMs: HOUR_MS,
        maxRecords: 100,
      },
      ["11111111-aaaa-7777-aaaa-bbbbbbbbbbbb"]
    );
    expect(count).toBe(1);
    expect(rows[0].embeddingBackfillStatus).toBe("failed");
    expect(rows[0].embeddingBackfillStartedAt).toBeNull();
  });

  it("CAS guard: skips rows whose status changed between SELECT and UPDATE", async () => {
    const rows: MockRow[] = [
      {
        id: "22222222-bbbb-7777-aaaa-bbbbbbbbbbbb",
        // Worker won the race and already transitioned to completed.
        embeddingBackfillStatus: "completed",
        embeddingBackfillStartedAt: null,
        embeddingBackfillRetryCount: 0,
      },
    ];
    const prisma = makeMockPrisma(rows);
    const count = await applyForceRelease(
      prisma,
      {
        dryRun: false,
        confirm: true,
        statusFrom: "in_progress",
        statusTo: "failed",
        skipReason: "dispatch_phase_failed",
        olderThanMs: HOUR_MS,
        maxRecords: 100,
      },
      ["22222222-bbbb-7777-aaaa-bbbbbbbbbbbb"]
    );
    expect(count).toBe(0);
    // Row remains untouched.
    expect(rows[0].embeddingBackfillStatus).toBe("completed");
  });

  it("returns 0 when given an empty id list (no SQL emitted)", async () => {
    const prisma = makeMockPrisma([]);
    const count = await applyForceRelease(
      prisma,
      {
        dryRun: false,
        confirm: true,
        statusFrom: "in_progress",
        statusTo: "failed",
        skipReason: "dispatch_phase_failed",
        olderThanMs: HOUR_MS,
        maxRecords: 100,
      },
      []
    );
    expect(count).toBe(0);
    expect(prisma.webPage.updateMany).not.toHaveBeenCalled();
  });
});

// ============================================================================
// runForceReconcile tests (dry-run vs confirm)
// ============================================================================

describe("force-reconcile-backfill runForceReconcile (v0.4.0 PR7e-β4 PR1)", () => {
  beforeEach(() => {
    resetAuditLogPrismaClientFactory();
    resetAuditLogService();
  });

  afterEach(() => {
    resetAuditLogPrismaClientFactory();
    resetAuditLogService();
  });

  it("dry-run reports detected count without calling updateMany", async () => {
    const rows: MockRow[] = [
      {
        id: "11111111-aaaa-7777-aaaa-bbbbbbbbbbbb",
        embeddingBackfillStatus: "in_progress",
        embeddingBackfillStartedAt: pastDate(2 * HOUR_MS),
        embeddingBackfillRetryCount: 0,
      },
    ];
    const prisma = makeMockPrisma(rows);
    const result = await runForceReconcile(prisma, {
      dryRun: true,
      confirm: false,
      statusFrom: "in_progress",
      statusTo: "failed",
      skipReason: "dispatch_phase_failed",
      olderThanMs: HOUR_MS,
      maxRecords: 100,
    });
    expect(result.detected).toBe(1);
    expect(result.released).toBe(0);
    expect(prisma.webPage.updateMany).not.toHaveBeenCalled();
    // Row must still be in_progress.
    expect(rows[0].embeddingBackfillStatus).toBe("in_progress");
  });

  it("confirm transitions stuck rows in_progress → failed", async () => {
    const rows: MockRow[] = [
      {
        id: "11111111-aaaa-7777-aaaa-bbbbbbbbbbbb",
        embeddingBackfillStatus: "in_progress",
        embeddingBackfillStartedAt: pastDate(2 * HOUR_MS),
        embeddingBackfillRetryCount: 0,
      },
    ];
    const prisma = makeMockPrisma(rows);
    const result = await runForceReconcile(prisma, {
      dryRun: false,
      confirm: true,
      statusFrom: "in_progress",
      statusTo: "failed",
      skipReason: "dispatch_phase_failed",
      olderThanMs: HOUR_MS,
      maxRecords: 100,
    });
    expect(result.detected).toBe(1);
    expect(result.released).toBe(1);
    expect(rows[0].embeddingBackfillStatus).toBe("failed");
    expect(rows[0].embeddingBackfillStartedAt).toBeNull();
  });

  it("--web-page-id filter scopes the SELECT", async () => {
    const rows: MockRow[] = [
      {
        id: "aaaaaaaa-1111-7777-aaaa-bbbbbbbbbbbb",
        embeddingBackfillStatus: "in_progress",
        embeddingBackfillStartedAt: pastDate(2 * HOUR_MS),
        embeddingBackfillRetryCount: 0,
      },
      {
        id: "bbbbbbbb-2222-7777-aaaa-bbbbbbbbbbbb",
        embeddingBackfillStatus: "in_progress",
        embeddingBackfillStartedAt: pastDate(2 * HOUR_MS),
        embeddingBackfillRetryCount: 0,
      },
    ];
    const prisma = makeMockPrisma(rows);
    const result = await runForceReconcile(prisma, {
      dryRun: false,
      confirm: true,
      webPageId: "aaaaaaaa-1111-7777-aaaa-bbbbbbbbbbbb",
      statusFrom: "in_progress",
      statusTo: "failed",
      skipReason: "dispatch_phase_failed",
      olderThanMs: HOUR_MS,
      maxRecords: 100,
    });
    expect(result.detected).toBe(1);
    expect(result.released).toBe(1);
    expect(rows[0].embeddingBackfillStatus).toBe("failed");
    expect(rows[1].embeddingBackfillStatus).toBe("in_progress"); // untouched
  });

  it("candidates carry truncated webPageId (PII safety)", async () => {
    const rows: MockRow[] = [
      {
        id: "33333333-aaaa-7777-aaaa-bbbbbbbbbbbb",
        embeddingBackfillStatus: "in_progress",
        embeddingBackfillStartedAt: pastDate(2 * HOUR_MS),
        embeddingBackfillRetryCount: 0,
      },
    ];
    const prisma = makeMockPrisma(rows);
    const result = await runForceReconcile(prisma, {
      dryRun: true,
      confirm: false,
      statusFrom: "in_progress",
      statusTo: "failed",
      skipReason: "dispatch_phase_failed",
      olderThanMs: HOUR_MS,
      maxRecords: 100,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].webPageIdTruncated).toMatch(/^33333333\.\.\.$/);
    expect(result.candidates[0].webPageIdTruncated).not.toContain("aaaa");
  });
});

// ============================================================================
// audit_logs recording (PR7d-3 LCC MEDIUM-2 pattern)
// ============================================================================

describe("force-reconcile-backfill audit_logs recording (v0.4.0 PR7e-β4 PR1)", () => {
  let auditCreateCalls: Array<{
    action: string;
    actor: string;
    targetType: string;
    targetId: string | null;
    details: Record<string, unknown> | null;
    ipAddress: string | null;
    result: string;
  }>;

  beforeEach(() => {
    auditCreateCalls = [];
    const mockAuditPrisma: AuditLogPrismaClient = {
      auditLog: {
        create: vi.fn(async ({ data }) => {
          auditCreateCalls.push(data);
          return { id: "audit-mock-id" };
        }),
        findMany: vi.fn(async () => []),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        count: vi.fn(async () => 0),
      },
    };
    setAuditLogPrismaClientFactory(() => mockAuditPrisma);
    resetAuditLogService();
  });

  afterEach(() => {
    resetAuditLogPrismaClientFactory();
    resetAuditLogService();
  });

  it("writes a backfill_stuck_released entry in dry-run mode", async () => {
    const rows: MockRow[] = [
      {
        id: "44444444-aaaa-7777-aaaa-bbbbbbbbbbbb",
        embeddingBackfillStatus: "in_progress",
        embeddingBackfillStartedAt: pastDate(2 * HOUR_MS),
        embeddingBackfillRetryCount: 0,
      },
    ];
    const prisma = makeMockPrisma(rows);

    await runForceReconcile(prisma, {
      dryRun: true,
      confirm: false,
      statusFrom: "in_progress",
      statusTo: "failed",
      skipReason: "dispatch_phase_failed",
      olderThanMs: HOUR_MS,
      maxRecords: 100,
    });

    expect(auditCreateCalls).toHaveLength(1);
    const entry = auditCreateCalls[0];
    expect(entry.action).toBe("backfill_stuck_released");
    expect(entry.actor).toBe("system:force-reconcile-backfill");
    expect(entry.targetType).toBe("web_page");
    expect(entry.result).toBe("success");
    expect(entry.details).toMatchObject({
      executionMode: "dry-run",
      detectedCount: 1,
      releasedCount: 0,
      statusFrom: "in_progress",
      statusTo: "failed",
      skipReason: "dispatch_phase_failed",
      olderThanMs: HOUR_MS,
    });
    const truncated = (entry.details as Record<string, unknown>).webPageIdsTruncated as string[];
    expect(truncated).toEqual([expect.stringMatching(/^44444444\.\.\.$/)]);
  });

  it("writes a backfill_stuck_released entry in confirm mode with releasedCount", async () => {
    const rows: MockRow[] = [
      {
        id: "55555555-aaaa-7777-aaaa-bbbbbbbbbbbb",
        embeddingBackfillStatus: "in_progress",
        embeddingBackfillStartedAt: pastDate(2 * HOUR_MS),
        embeddingBackfillRetryCount: 0,
      },
    ];
    const prisma = makeMockPrisma(rows);

    await runForceReconcile(prisma, {
      dryRun: false,
      confirm: true,
      statusFrom: "in_progress",
      statusTo: "failed",
      skipReason: "dispatch_phase_failed",
      olderThanMs: HOUR_MS,
      maxRecords: 100,
    });

    expect(auditCreateCalls).toHaveLength(1);
    expect(auditCreateCalls[0].details).toMatchObject({
      executionMode: "confirm",
      detectedCount: 1,
      releasedCount: 1,
    });
  });

  it("includes category in audit_logs when --category is given", async () => {
    const rows: MockRow[] = [
      {
        id: "66666666-aaaa-7777-aaaa-bbbbbbbbbbbb",
        embeddingBackfillStatus: "in_progress",
        embeddingBackfillStartedAt: pastDate(2 * HOUR_MS),
        embeddingBackfillRetryCount: 0,
      },
    ];
    const prisma = makeMockPrisma(rows);

    await runForceReconcile(prisma, {
      dryRun: true,
      confirm: false,
      category: "part_visual",
      statusFrom: "in_progress",
      statusTo: "failed",
      skipReason: "dispatch_phase_failed",
      olderThanMs: HOUR_MS,
      maxRecords: 100,
    });

    expect(auditCreateCalls).toHaveLength(1);
    expect(auditCreateCalls[0].details).toMatchObject({
      category: "part_visual",
    });
  });

  it("includes targetWebPageIdTruncated in audit when --web-page-id is given", async () => {
    const rows: MockRow[] = [
      {
        id: "77777777-aaaa-7777-aaaa-bbbbbbbbbbbb",
        embeddingBackfillStatus: "in_progress",
        embeddingBackfillStartedAt: pastDate(2 * HOUR_MS),
        embeddingBackfillRetryCount: 0,
      },
    ];
    const prisma = makeMockPrisma(rows);

    await runForceReconcile(prisma, {
      dryRun: true,
      confirm: false,
      webPageId: "77777777-aaaa-7777-aaaa-bbbbbbbbbbbb",
      statusFrom: "in_progress",
      statusTo: "failed",
      skipReason: "dispatch_phase_failed",
      olderThanMs: HOUR_MS,
      maxRecords: 100,
    });

    expect(auditCreateCalls).toHaveLength(1);
    expect((auditCreateCalls[0].details as Record<string, unknown>).targetWebPageIdTruncated).toBe(
      "77777777..."
    );
  });

  it("still writes an audit entry when zero candidates are detected", async () => {
    const prisma = makeMockPrisma([]);
    await runForceReconcile(prisma, {
      dryRun: true,
      confirm: false,
      statusFrom: "in_progress",
      statusTo: "failed",
      skipReason: "dispatch_phase_failed",
      olderThanMs: HOUR_MS,
      maxRecords: 100,
    });
    expect(auditCreateCalls).toHaveLength(1);
    expect(auditCreateCalls[0].details).toMatchObject({
      executionMode: "dry-run",
      detectedCount: 0,
      releasedCount: 0,
    });
  });

  it("audit log failure does not abort runForceReconcile (graceful degradation)", async () => {
    // Inject a factory whose create() throws.
    const failingAuditPrisma: AuditLogPrismaClient = {
      auditLog: {
        create: vi.fn(async () => {
          throw new Error("simulated audit DB outage");
        }),
        findMany: vi.fn(async () => []),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        count: vi.fn(async () => 0),
      },
    };
    setAuditLogPrismaClientFactory(() => failingAuditPrisma);
    resetAuditLogService();

    const rows: MockRow[] = [
      {
        id: "88888888-aaaa-7777-aaaa-bbbbbbbbbbbb",
        embeddingBackfillStatus: "in_progress",
        embeddingBackfillStartedAt: pastDate(2 * HOUR_MS),
        embeddingBackfillRetryCount: 0,
      },
    ];
    const prisma = makeMockPrisma(rows);

    // Should not throw despite audit log failure.
    const result = await runForceReconcile(prisma, {
      dryRun: false,
      confirm: true,
      statusFrom: "in_progress",
      statusTo: "failed",
      skipReason: "dispatch_phase_failed",
      olderThanMs: HOUR_MS,
      maxRecords: 100,
    });
    expect(result.released).toBe(1);
    expect(rows[0].embeddingBackfillStatus).toBe("failed");
  });
});
