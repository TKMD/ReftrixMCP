// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * v0.4.0 PR7d-1: repair-orphaned-backfill-records script tests.
 *
 * Covers:
 *  - CLI parseArgs defaults to dry-run
 *  - --confirm flips mode
 *  - runRepair in dry-run reports detected count but does not update
 *  - runRepair with --confirm transitions rows to skipped_screenshot_missing
 *  - runRepair does not count rows whose screenshot still exists (false-positive guard)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  parseArgs,
  findOrphanedCandidates,
  runRepair,
} from "../../scripts/repair-orphaned-backfill-records";
// v0.4.0 PR7d-3 (LCC MEDIUM-2): verify audit_logs recording.
import {
  setAuditLogPrismaClientFactory,
  resetAuditLogPrismaClientFactory,
  resetAuditLogService,
  type AuditLogPrismaClient,
} from "../../src/services/audit-log.service";

// -------- Prisma mock -------
// Minimal mock: findMany / updateMany only.
interface MockRow {
  id: string;
  screenshotStoragePath: string | null;
  embeddingBackfillStatus: string;
}

function makeMockPrisma(rows: MockRow[]): {
  webPage: {
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
} {
  const db = [...rows];
  return {
    webPage: {
      findMany: vi.fn(async (_args: unknown) => {
        return db.map((r) => ({
          id: r.id,
          screenshotStoragePath: r.screenshotStoragePath,
          embeddingBackfillStatus: r.embeddingBackfillStatus,
        }));
      }),
      updateMany: vi.fn(
        async (args: {
          where: { id: string; embeddingBackfillStatus?: { in: string[] } };
          data: { embeddingBackfillStatus: string };
        }) => {
          let count = 0;
          for (const r of db) {
            if (
              r.id === args.where.id &&
              (!args.where.embeddingBackfillStatus ||
                args.where.embeddingBackfillStatus.in.includes(r.embeddingBackfillStatus))
            ) {
              r.embeddingBackfillStatus = args.data.embeddingBackfillStatus;
              count += 1;
            }
          }
          return { count };
        }
      ),
    },
  };
}

describe("repair-orphaned-backfill-records CLI parseArgs (v0.4.0 PR7d-1)", () => {
  it("defaults to dry-run when no flags", () => {
    const args = parseArgs(["node", "repair.ts"]);
    expect(args.dryRun).toBe(true);
    expect(args.confirm).toBe(false);
  });

  it("--confirm switches off dry-run", () => {
    const args = parseArgs(["node", "repair.ts", "--confirm"]);
    expect(args.confirm).toBe(true);
    expect(args.dryRun).toBe(false);
  });

  it("--dry-run + --confirm keeps dry-run (explicit safety)", () => {
    const args = parseArgs(["node", "repair.ts", "--dry-run", "--confirm"]);
    // --dry-run explicitly set means dry-run wins
    expect(args.dryRun).toBe(true);
  });
});

describe("repair-orphaned-backfill-records runRepair (v0.4.0 PR7d-1)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reftrix-repair-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("dry-run reports detected count without mutating DB", async () => {
    const missingPath = path.join(tmpDir, "ghost-webpage.png");
    const rows: MockRow[] = [
      {
        id: "00000000-1111-7777-aaaa-bbbbbbbbbbbb",
        screenshotStoragePath: missingPath,
        embeddingBackfillStatus: "queued",
      },
    ];
    const mockPrisma = makeMockPrisma(rows);

    const result = await runRepair(mockPrisma as unknown as Parameters<typeof runRepair>[0], {
      dryRun: true,
      confirm: false,
    });

    expect(result.detected).toBe(1);
    expect(result.updated).toBe(0);
    expect(mockPrisma.webPage.updateMany).not.toHaveBeenCalled();
    // Row must still be queued (no mutation).
    expect(rows[0].embeddingBackfillStatus).toBe("queued");
  });

  it("--confirm transitions rows to skipped_screenshot_missing", async () => {
    const missingPath = path.join(tmpDir, "ghost2.png");
    const rows: MockRow[] = [
      {
        id: "11111111-2222-7777-aaaa-bbbbbbbbbbbb",
        screenshotStoragePath: missingPath,
        embeddingBackfillStatus: "in_progress",
      },
    ];
    const mockPrisma = makeMockPrisma(rows);

    const result = await runRepair(mockPrisma as unknown as Parameters<typeof runRepair>[0], {
      dryRun: false,
      confirm: true,
    });

    expect(result.detected).toBe(1);
    expect(result.updated).toBe(1);
    expect(rows[0].embeddingBackfillStatus).toBe("skipped_screenshot_missing");
  });

  it("does NOT detect rows whose screenshot file still exists (false-positive guard)", async () => {
    const presentPath = path.join(tmpDir, "present.png");
    fs.writeFileSync(presentPath, Buffer.alloc(10), { mode: 0o600 });

    const rows: MockRow[] = [
      {
        id: "22222222-3333-7777-aaaa-bbbbbbbbbbbb",
        screenshotStoragePath: presentPath,
        embeddingBackfillStatus: "queued",
      },
    ];
    const mockPrisma = makeMockPrisma(rows);

    const candidates = await findOrphanedCandidates(
      mockPrisma as unknown as Parameters<typeof findOrphanedCandidates>[0]
    );
    expect(candidates).toEqual([]);

    const result = await runRepair(mockPrisma as unknown as Parameters<typeof runRepair>[0], {
      dryRun: false,
      confirm: true,
    });
    expect(result.detected).toBe(0);
    expect(result.updated).toBe(0);
    expect(rows[0].embeddingBackfillStatus).toBe("queued");
  });

  it("dry-run candidates carry truncated webPageId (PII safety)", async () => {
    const missingPath = path.join(tmpDir, "ghost3.png");
    const rows: MockRow[] = [
      {
        id: "33333333-4444-7777-aaaa-bbbbbbbbbbbb",
        screenshotStoragePath: missingPath,
        embeddingBackfillStatus: "queued",
      },
    ];
    const mockPrisma = makeMockPrisma(rows);

    const result = await runRepair(mockPrisma as unknown as Parameters<typeof runRepair>[0], {
      dryRun: true,
      confirm: false,
    });

    expect(result.candidates).toHaveLength(1);
    // First 8 chars + ... — the id starts with 33333333-...
    expect(result.candidates[0].webPageIdTruncated).toMatch(/^33333333\.\.\.$/);
    // Must NOT contain the full UUID
    expect(result.candidates[0].webPageIdTruncated).not.toContain("aaaa");
  });
});

// ============================================================================
// v0.4.0 PR7d-3 (LCC MEDIUM-2): audit_logs recording
// ============================================================================

describe("repair-orphaned-backfill-records audit_logs recording (v0.4.0 PR7d-3)", () => {
  let tmpDir: string;
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reftrix-repair-audit-"));
    auditCreateCalls = [];
    // Inject a mock AuditLogPrismaClient so `.log()` actually writes (vs.
    // silently no-op when the DI factory is unset).
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
    resetAuditLogService(); // force re-construction with the new factory
  });

  afterEach(() => {
    resetAuditLogPrismaClientFactory();
    resetAuditLogService();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("writes a backfill_orphaned_repaired audit entry in dry-run mode", async () => {
    const missingPath = path.join(tmpDir, "audit-dry.png");
    const rows: MockRow[] = [
      {
        id: "44444444-5555-7777-aaaa-bbbbbbbbbbbb",
        screenshotStoragePath: missingPath,
        embeddingBackfillStatus: "queued",
      },
    ];
    const mockPrisma = makeMockPrisma(rows);

    await runRepair(mockPrisma as unknown as Parameters<typeof runRepair>[0], {
      dryRun: true,
      confirm: false,
    });

    expect(auditCreateCalls).toHaveLength(1);
    const entry = auditCreateCalls[0];
    expect(entry.action).toBe("backfill_orphaned_repaired");
    expect(entry.actor).toBe("system:repair-orphaned-backfill-records");
    expect(entry.targetType).toBe("web_page");
    expect(entry.result).toBe("success");
    expect(entry.details).toMatchObject({
      executionMode: "dry-run",
      detectedCount: 1,
      repairedCount: 0,
    });
    // PII hygiene: audit details must carry truncated IDs only.
    const truncated = (entry.details as Record<string, unknown>).webPageIdsTruncated as string[];
    expect(truncated).toEqual([expect.stringMatching(/^44444444\.\.\.$/)]);
  });

  it("writes a backfill_orphaned_repaired audit entry in confirm mode with repairedCount", async () => {
    const missingPath = path.join(tmpDir, "audit-confirm.png");
    const rows: MockRow[] = [
      {
        id: "55555555-6666-7777-aaaa-bbbbbbbbbbbb",
        screenshotStoragePath: missingPath,
        embeddingBackfillStatus: "in_progress",
      },
    ];
    const mockPrisma = makeMockPrisma(rows);

    await runRepair(mockPrisma as unknown as Parameters<typeof runRepair>[0], {
      dryRun: false,
      confirm: true,
    });

    expect(auditCreateCalls).toHaveLength(1);
    const entry = auditCreateCalls[0];
    expect(entry.details).toMatchObject({
      executionMode: "confirm",
      detectedCount: 1,
      repairedCount: 1,
    });
  });

  it("still writes an audit entry when no candidates are detected (zero detected)", async () => {
    const rows: MockRow[] = [];
    const mockPrisma = makeMockPrisma(rows);

    await runRepair(mockPrisma as unknown as Parameters<typeof runRepair>[0], {
      dryRun: true,
      confirm: false,
    });

    expect(auditCreateCalls).toHaveLength(1);
    expect(auditCreateCalls[0].details).toMatchObject({
      executionMode: "dry-run",
      detectedCount: 0,
      repairedCount: 0,
    });
  });
});
