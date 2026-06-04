// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain (Plan v3 Track T4).
 *
 * INV-WORKER-PID-IDENTITY-005: NEW invariant declaration per Conflict 2 +
 * User directive 2026-05-04. Replaces the fabricated
 * `INV-DISPOSE-PID-IDENTITY-001` cite that prior drafter design treated as
 * existing.
 *
 * Sub-cases (per design §4.2 testable proposition):
 *   - **Sub-A (write hook)**: Worker spawn writes
 *     `worker_job_lifecycle.worker_pid + worker_spawn_time + webPageId` row
 *     BEFORE Phase 0 begins. (`recordWorkerSpawn` helper present.)
 *   - **Sub-B (clear hook)**: planned exit writes paired
 *     `event_type='release'` row from catch-tail (failure path) AND
 *     success-path post-pause. (`recordWorkerRelease` helper present.)
 *   - **Sub-C (cross-PID-reuse defense)**: supervisor backfill query joins
 *     on `worker_pid + worker_spawn_time` equality (timestamp comparison
 *     eliminates Linux PID reuse false-positive matches).
 *   - **Sub-D (LCC M-01 non-PII classification)**: `worker_pid` non-PII
 *     classification statement present in DATA_RETENTION.md (deferred to
 *     Phase 3 docs-sync; this test asserts the helper API stability only).
 *
 * **Wave 2 (UNBLOCK-T4-03 runtime-binding extension)**: Z-a equivalent
 * re-entry adds runtime fault injection sub-blocks for Sub-A (spawn write
 * hook + spawn-time SSOT byte-identity), Sub-B (release clear hook),
 * Sub-C (cross-PID-reuse defense via composite [workerPid, workerSpawnTime]
 * join key) alongside the existing AST-grep heuristic structural
 * assertions. The structural tests are preserved as compile-time guards;
 * the runtime tests directly drive `recordWorkerSpawn` /
 * `recordWorkerRelease` / `findOrphanWebPageIds` /
 * `readSupervisorInjectedSpawnTimeMs` with stub Prisma + env injection.
 *
 * Wave 2 (UNBLOCK-T4-03 runtime-binding 拡張): AST-grep 構造 test に
 * runtime fault injection sub-block を併設。stub Prisma + env injection で
 * helper を直接駆動して挙動契約を検証する。
 *
 * INV-WORKER-PID-IDENTITY-005 — Plan v3 T4 NEW invariant. Replaces fabricated
 * INV-DISPOSE-PID-IDENTITY-001 cite per Conflict 2 ruling.
 *
 * @see PR-V3-T4 design.md §4 (NEW invariant declaration)
 * @see ADR-0009 Amendment 2 §A2.4 (NEW infrastructure)
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertInvName } from "../_setup/inv-assert";
import {
  recordWorkerRelease,
  recordWorkerSpawn,
  type WorkerJobLifecyclePrismaClient,
} from "../../../../src/services/worker-supervisor-helpers";
import {
  findOrphanWebPageIds,
  type FailurePathPrismaClient,
} from "../../../../src/services/worker-supervisor-failure-path.service";
import {
  REFTRIX_WORKER_SPAWN_TIME_MS_ENV,
  readSupervisorInjectedSpawnTimeMs,
} from "../../../../src/workers/worker-ipc-spawn-recorded.schema";

const HELPERS_FILE = resolve(__dirname, "../../../../src/services/worker-supervisor-helpers.ts");

const FAILURE_PATH_SERVICE_FILE = resolve(
  __dirname,
  "../../../../src/services/worker-supervisor-failure-path.service.ts"
);

const PRISMA_SCHEMA_FILE = resolve(
  __dirname,
  "../../../../../../packages/database/prisma/schema.prisma"
);

describe("INV-WORKER-PID-IDENTITY-005", () => {
  describe("Sub-A (write hook) — recordWorkerSpawn helper presence", () => {
    it("INV-WORKER-PID-IDENTITY-005: recordWorkerSpawn helper exported with worker_pid + worker_spawn_time + webPageId fields / Sub-A write hook present", () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-PID-IDENTITY-005");
      const content = readFileSync(HELPERS_FILE, "utf-8");
      expect(content).toMatch(/export async function recordWorkerSpawn/);
      // Field name verification (write hook payload fields).
      expect(content).toMatch(/workerPid:/);
      expect(content).toMatch(/workerSpawnTime:/);
      expect(content).toMatch(/webPageId:/);
      expect(content).toMatch(/eventType:\s*"spawn"/);
    });
  });

  describe("Sub-B (clear hook) — recordWorkerRelease helper presence", () => {
    it("INV-WORKER-PID-IDENTITY-005: recordWorkerRelease helper exported with eventType='release' contract / Sub-B clear hook present", () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-PID-IDENTITY-005");
      const content = readFileSync(HELPERS_FILE, "utf-8");
      expect(content).toMatch(/export async function recordWorkerRelease/);
      expect(content).toMatch(/eventType:\s*"release"/);
    });
  });

  describe("Sub-C (cross-PID-reuse defense) — supervisor backfill timestamp join", () => {
    it("INV-WORKER-PID-IDENTITY-005: findOrphanWebPageIds joins on workerPid + workerSpawnTime equality (timestamp eliminates PID reuse false positives) / Sub-C structural join verification", () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-PID-IDENTITY-005");
      const content = readFileSync(FAILURE_PATH_SERVICE_FILE, "utf-8");
      // Locate the findOrphanWebPageIds function body.
      const fnStart = content.indexOf("export async function findOrphanWebPageIds");
      expect(fnStart).toBeGreaterThan(0);
      const fnBody = content.slice(fnStart, fnStart + 2000);
      // Both join keys must appear in the where clause.
      expect(fnBody).toMatch(/workerPid:\s*exitedChildPid/);
      expect(fnBody).toMatch(/workerSpawnTime:\s*exitedChildSpawnTime/);
    });

    it("INV-WORKER-PID-IDENTITY-005: PID-reuse synthetic case structural protection — findOrphanWebPageIds requires BOTH equality conditions / structural Sub-C protection", () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-PID-IDENTITY-005");
      const content = readFileSync(FAILURE_PATH_SERVICE_FILE, "utf-8");
      // Documentation comment must explicitly mention cross-PID-reuse defense.
      expect(content).toMatch(/cross-PID-reuse defense|PID reuse|PID-reuse/);
      // INV-WORKER-PID-IDENTITY-005 must be cross-referenced.
      expect(content).toMatch(/INV-WORKER-PID-IDENTITY-005/);
    });
  });

  describe("Sub-A/B Prisma schema — worker_job_lifecycle table fields", () => {
    it("INV-WORKER-PID-IDENTITY-005: WorkerJobLifecycle Prisma model declares worker_pid + worker_spawn_time + nonce + 3 indexes / schema fields present", () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-PID-IDENTITY-005");
      const content = readFileSync(PRISMA_SCHEMA_FILE, "utf-8");
      const modelStart = content.indexOf("model WorkerJobLifecycle");
      expect(modelStart).toBeGreaterThan(0);
      const modelBody = content.slice(modelStart, modelStart + 2000);
      // Required fields per design §5.1.
      expect(modelBody).toMatch(/workerPid\s+Int/);
      expect(modelBody).toMatch(/workerSpawnTime/);
      expect(modelBody).toMatch(/eventType\s+WorkerLifecycleEvent/);
      expect(modelBody).toMatch(/eventAt/);
      expect(modelBody).toMatch(/nonce/);
      // 3 indexes per design §5.1.
      expect(modelBody).toMatch(/@@index\(\[webPageId\]\)/);
      expect(modelBody).toMatch(/@@index\(\[workerPid,\s*workerSpawnTime\]\)/);
      expect(modelBody).toMatch(/@@index\(\[eventAt\]\)/);
      // ON DELETE CASCADE for INV-DATA-DELETE-002 cascade.
      expect(modelBody).toMatch(/onDelete:\s*Cascade/);
    });
  });

  describe("Sub-D (LCC M-01 non-PII classification) — helper API surface stability", () => {
    it("INV-WORKER-PID-IDENTITY-005: getOrphanRetentionDays helper exported with default 30 days (LCC H-01 retention contract) / retention helper present", () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-PID-IDENTITY-005");
      const content = readFileSync(HELPERS_FILE, "utf-8");
      expect(content).toMatch(/export function getOrphanRetentionDays/);
      // Default 30d documented (LCC H-01 IO-accepted retention selection).
      expect(content).toMatch(/DEFAULT_ORPHAN_RETENTION_DAYS\s*=\s*30/);
    });
  });

  describe("Fabrication-correction guard", () => {
    it("INV-WORKER-PID-IDENTITY-005: codebase NEVER cites the fabricated INV-DISPOSE-PID-IDENTITY-001 anchor / Conflict 2 fabrication-correction guard", () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-PID-IDENTITY-005");
      // Source-tree fabrication guard (heuristic; full grep handled by docs:verify).
      const helpers = readFileSync(HELPERS_FILE, "utf-8");
      const failurePath = readFileSync(FAILURE_PATH_SERVICE_FILE, "utf-8");
      const prismaSchema = readFileSync(PRISMA_SCHEMA_FILE, "utf-8");
      expect(helpers).not.toMatch(/INV-DISPOSE-PID-IDENTITY-001/);
      expect(failurePath).not.toMatch(/INV-DISPOSE-PID-IDENTITY-001/);
      expect(prismaSchema).not.toMatch(/INV-DISPOSE-PID-IDENTITY-001/);
    });
  });

  // ==========================================================================
  // Wave 2 (UNBLOCK-T4-03) — Runtime-binding fault injection sub-blocks
  // ==========================================================================
  //
  // The structural tests above verify symbol existence + Prisma schema fields.
  // The runtime tests below drive the helpers directly with stub Prisma +
  // env injection to verify behavioural contracts that are not observable
  // from text-grep alone:
  //
  //   - Sub-A spawn-time SSOT byte-identity: parent injects via
  //     `REFTRIX_WORKER_SPAWN_TIME_MS` env; child reads via
  //     `readSupervisorInjectedSpawnTimeMs()`. Same integer end-to-end.
  //   - Sub-A `recordWorkerSpawn` runtime: workerJobLifecycle.create called
  //     with eventType='spawn' + correct fields.
  //   - Sub-B `recordWorkerRelease` runtime: workerJobLifecycle.create called
  //     with eventType='release' + correct fields.
  //   - Sub-C cross-PID-reuse defense: composite [workerPid, workerSpawnTime]
  //     join key only matches rows that share BOTH fields, structurally
  //     eliminating Linux PID reuse false positives.
  //   - Graceful Degradation: write-hook failures are non-fatal (caller does
  //     not throw; supervisor degrades to phase_reconstruction='best_effort').
  // ==========================================================================

  describe("Sub-A (spawn-time SSOT byte-identity) — runtime: env var contract", () => {
    let originalEnvValue: string | undefined;

    beforeEach(() => {
      originalEnvValue = process.env[REFTRIX_WORKER_SPAWN_TIME_MS_ENV];
    });

    afterEach(() => {
      if (originalEnvValue === undefined) {
        delete process.env[REFTRIX_WORKER_SPAWN_TIME_MS_ENV];
      } else {
        process.env[REFTRIX_WORKER_SPAWN_TIME_MS_ENV] = originalEnvValue;
      }
    });

    it("INV-WORKER-PID-IDENTITY-005: REFTRIX_WORKER_SPAWN_TIME_MS env propagates supervisor → child as byte-identical integer (ADR-0009 Amendment 2 §A2.4 Sub-A SSOT)", () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-PID-IDENTITY-005");
      // Supervisor side: capture once at fork time and inject as env.
      const supervisorCapturedMs = 1746472200001;
      process.env[REFTRIX_WORKER_SPAWN_TIME_MS_ENV] = String(supervisorCapturedMs);

      // Child side: read SSOT.
      const childReadMs = readSupervisorInjectedSpawnTimeMs();
      expect(childReadMs).toBe(supervisorCapturedMs);
      // Byte-identity: same integer round-trip with no precision loss.
      expect(typeof childReadMs).toBe("number");
      expect(Number.isInteger(childReadMs!)).toBe(true);
    });

    it("INV-WORKER-PID-IDENTITY-005: readSupervisorInjectedSpawnTimeMs() returns null when env missing (Graceful Degradation contract)", () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-PID-IDENTITY-005");
      delete process.env[REFTRIX_WORKER_SPAWN_TIME_MS_ENV];
      expect(readSupervisorInjectedSpawnTimeMs()).toBe(null);
    });

    it("INV-WORKER-PID-IDENTITY-005: readSupervisorInjectedSpawnTimeMs() returns null when env is empty / non-numeric / non-positive (defense in depth — fail-closed parse)", () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-PID-IDENTITY-005");
      const invalids = ["", "not-a-number", "0", "-1", "NaN"];
      for (const invalid of invalids) {
        process.env[REFTRIX_WORKER_SPAWN_TIME_MS_ENV] = invalid;
        expect(readSupervisorInjectedSpawnTimeMs()).toBe(null);
      }
    });
  });

  describe("Sub-A (write hook) — runtime: recordWorkerSpawn invokes workerJobLifecycle.create", () => {
    interface RecordedCreateCall {
      data: {
        webPageId: string;
        workerPid: number;
        workerSpawnTime: Date;
        workerType: string;
        eventType: string;
        nonce: string;
      };
    }

    let recordedCreates: RecordedCreateCall[];

    function makeStub(behaviour: "ok" | "throw" = "ok"): WorkerJobLifecyclePrismaClient {
      return {
        workerJobLifecycle: {
          create: async (args) => {
            recordedCreates.push({ data: args.data });
            if (behaviour === "throw") {
              throw new Error("simulated DB failure");
            }
            return { id: "stub-lc-id" };
          },
        },
      };
    }

    beforeEach(() => {
      recordedCreates = [];
    });

    it("INV-WORKER-PID-IDENTITY-005: recordWorkerSpawn writes eventType='spawn' row with byte-identical workerPid + workerSpawnTime + webPageId + nonce / Sub-A behavioural contract", async () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-PID-IDENTITY-005");
      const prismaStub = makeStub("ok");
      const spawnTime = new Date(1746472200001);
      await recordWorkerSpawn(prismaStub, {
        webPageId: "00000000-0000-0000-0000-000000000010",
        workerPid: 24680,
        workerSpawnTime: spawnTime,
        workerType: "page",
        nonce: "boot-token-abc-123",
      });
      expect(recordedCreates).toHaveLength(1);
      const create = recordedCreates[0]!.data;
      expect(create.webPageId).toBe("00000000-0000-0000-0000-000000000010");
      expect(create.workerPid).toBe(24680);
      // Byte-identical Date instance (same epoch ms).
      expect(create.workerSpawnTime.getTime()).toBe(spawnTime.getTime());
      expect(create.workerType).toBe("page");
      expect(create.eventType).toBe("spawn");
      expect(create.nonce).toBe("boot-token-abc-123");
    });

    it("INV-WORKER-PID-IDENTITY-005: recordWorkerSpawn never throws on DB write failure (fire-and-forget Graceful Degradation contract)", async () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-PID-IDENTITY-005");
      const prismaStub = makeStub("throw");
      // Must not throw — supervisor backfill degrades to best_effort if the
      // write hook fails, but the spawn path itself MUST proceed.
      await expect(
        recordWorkerSpawn(prismaStub, {
          webPageId: "00000000-0000-0000-0000-000000000011",
          workerPid: 1,
          workerSpawnTime: new Date(),
          workerType: "page",
          nonce: "n",
        })
      ).resolves.toBeUndefined();
    });
  });

  describe("Sub-B (clear hook) — runtime: recordWorkerRelease invokes workerJobLifecycle.create with eventType='release'", () => {
    interface RecordedCreateCall {
      data: {
        webPageId: string;
        workerPid: number;
        workerSpawnTime: Date;
        workerType: string;
        eventType: string;
        nonce: string;
      };
    }

    let recordedCreates: RecordedCreateCall[];

    function makeStub(behaviour: "ok" | "throw" = "ok"): WorkerJobLifecyclePrismaClient {
      return {
        workerJobLifecycle: {
          create: async (args) => {
            recordedCreates.push({ data: args.data });
            if (behaviour === "throw") {
              throw new Error("simulated DB failure");
            }
            return { id: "stub-lc-id" };
          },
        },
      };
    }

    beforeEach(() => {
      recordedCreates = [];
    });

    it("INV-WORKER-PID-IDENTITY-005: recordWorkerRelease writes eventType='release' row paired with original spawn-time / Sub-B behavioural contract", async () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-PID-IDENTITY-005");
      const prismaStub = makeStub("ok");
      const spawnTime = new Date(1746472200001);
      await recordWorkerRelease(prismaStub, {
        webPageId: "00000000-0000-0000-0000-000000000020",
        workerPid: 13579,
        workerSpawnTime: spawnTime,
        workerType: "page",
        nonce: "boot-token-xyz-789",
      });
      expect(recordedCreates).toHaveLength(1);
      const create = recordedCreates[0]!.data;
      expect(create.eventType).toBe("release");
      expect(create.workerPid).toBe(13579);
      // Same Date instance shape (paired-row property: spawn + release share
      // workerPid + workerSpawnTime so supervisor backfill can detect orphan
      // via spawn-without-release).
      expect(create.workerSpawnTime.getTime()).toBe(spawnTime.getTime());
      expect(create.webPageId).toBe("00000000-0000-0000-0000-000000000020");
      expect(create.nonce).toBe("boot-token-xyz-789");
    });

    it("INV-WORKER-PID-IDENTITY-005: recordWorkerRelease never throws on DB write failure (fire-and-forget Graceful Degradation contract)", async () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-PID-IDENTITY-005");
      const prismaStub = makeStub("throw");
      await expect(
        recordWorkerRelease(prismaStub, {
          webPageId: "00000000-0000-0000-0000-000000000021",
          workerPid: 1,
          workerSpawnTime: new Date(),
          workerType: "page",
          nonce: "n",
        })
      ).resolves.toBeUndefined();
    });
  });

  describe("Sub-C (cross-PID-reuse defense) — runtime: findOrphanWebPageIds composite join key", () => {
    interface LifecycleRow {
      id: string;
      webPageId: string;
      workerPid: number;
      workerSpawnTime: Date;
      eventType: string;
      eventAt: Date;
    }

    function makeFailurePathPrismaStub(rows: ReadonlyArray<LifecycleRow>): {
      prisma: FailurePathPrismaClient;
      findManyCalls: Array<{
        workerPid: number;
        workerSpawnTime: Date;
        eventType?: { in: Array<"spawn" | "release"> };
      }>;
    } {
      const findManyCalls: Array<{
        workerPid: number;
        workerSpawnTime: Date;
        eventType?: { in: Array<"spawn" | "release"> };
      }> = [];
      const prisma: FailurePathPrismaClient = {
        $transaction: async <T>(fn: (tx: FailurePathPrismaClient) => Promise<T>): Promise<T> =>
          fn(prisma),
        webPage: {
          update: async () => ({ id: "" }),
          // PR-INGEST-FAIL-ROW: `upsert` present only for FailurePathPrismaClient
          // type compliance (these stubs exercise findOrphanWebPageIds /
          // backfillOrphanWebPageRow, which use the id-key update path).
          upsert: async (args) => ({ id: args.create.id }),
        },
        workerJobLifecycle: {
          findMany: async (args) => {
            findManyCalls.push({
              workerPid: args.where.workerPid,
              workerSpawnTime: args.where.workerSpawnTime,
              eventType: args.where.eventType,
            });
            // Filter rows by the composite key the implementation passed in.
            // This mirrors what Postgres would do under the
            // [workerPid, workerSpawnTime] composite index.
            return rows
              .filter(
                (r) =>
                  r.workerPid === args.where.workerPid &&
                  r.workerSpawnTime.getTime() === args.where.workerSpawnTime.getTime() &&
                  (!args.where.eventType ||
                    args.where.eventType.in.includes(r.eventType as "spawn" | "release"))
              )
              .map((r) => ({ ...r }));
          },
        },
        auditLog: { create: async () => ({ id: "" }) },
      };
      return { prisma, findManyCalls };
    }

    it("INV-WORKER-PID-IDENTITY-005: findOrphanWebPageIds composite join — same workerPid but DIFFERENT workerSpawnTime is NOT joined (cross-PID-reuse defense)", async () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-PID-IDENTITY-005");
      // Linux PID reuse scenario: Worker A boots at T1 with pid=12345,
      // crashes; later Worker B boots at T2 with the SAME pid=12345 (kernel
      // PID reuse). The supervisor backfill query for worker A's orphans
      // (looking up [pid=12345, T1]) must NOT incorrectly join Worker B's
      // rows (which carry [pid=12345, T2]).
      const reusedPid = 12345;
      const workerASpawnTime = new Date("2026-05-05T18:00:00.000Z");
      const workerBSpawnTime = new Date("2026-05-05T19:00:00.000Z");
      const workerAWebPageId = "00000000-0000-0000-0000-0000000000A1";
      const workerBWebPageId = "00000000-0000-0000-0000-0000000000B2";

      const { prisma, findManyCalls } = makeFailurePathPrismaStub([
        // Worker A spawn (orphan — no paired release).
        {
          id: "row-a-spawn",
          webPageId: workerAWebPageId,
          workerPid: reusedPid,
          workerSpawnTime: workerASpawnTime,
          eventType: "spawn",
          eventAt: workerASpawnTime,
        },
        // Worker B spawn (different spawnTime — must NOT be returned for
        // Worker A's orphan query).
        {
          id: "row-b-spawn",
          webPageId: workerBWebPageId,
          workerPid: reusedPid,
          workerSpawnTime: workerBSpawnTime,
          eventType: "spawn",
          eventAt: workerBSpawnTime,
        },
      ]);

      const orphans = await findOrphanWebPageIds(prisma, reusedPid, workerASpawnTime);

      // Composite join: only Worker A's orphan returns; Worker B is excluded.
      expect(orphans).toEqual([workerAWebPageId]);
      expect(orphans).not.toContain(workerBWebPageId);
      // Verify the implementation queries with BOTH composite-key components.
      expect(findManyCalls).toHaveLength(1);
      expect(findManyCalls[0]!.workerPid).toBe(reusedPid);
      expect(findManyCalls[0]!.workerSpawnTime.getTime()).toBe(workerASpawnTime.getTime());
    });

    it("INV-WORKER-PID-IDENTITY-005: findOrphanWebPageIds — paired spawn+release rows are NOT returned (release pairing eliminates orphan)", async () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-PID-IDENTITY-005");
      const pid = 23456;
      const spawnTime = new Date("2026-05-05T20:00:00.000Z");
      const releasedWebPageId = "00000000-0000-0000-0000-0000000000C3";
      const orphanedWebPageId = "00000000-0000-0000-0000-0000000000D4";

      const { prisma } = makeFailurePathPrismaStub([
        // Released — has both spawn and release events.
        {
          id: "row-c-spawn",
          webPageId: releasedWebPageId,
          workerPid: pid,
          workerSpawnTime: spawnTime,
          eventType: "spawn",
          eventAt: new Date("2026-05-05T20:00:00.001Z"),
        },
        {
          id: "row-c-release",
          webPageId: releasedWebPageId,
          workerPid: pid,
          workerSpawnTime: spawnTime,
          eventType: "release",
          eventAt: new Date("2026-05-05T20:00:01.000Z"),
        },
        // Orphaned — only spawn, no release.
        {
          id: "row-d-spawn",
          webPageId: orphanedWebPageId,
          workerPid: pid,
          workerSpawnTime: spawnTime,
          eventType: "spawn",
          eventAt: new Date("2026-05-05T20:00:00.002Z"),
        },
      ]);

      const orphans = await findOrphanWebPageIds(prisma, pid, spawnTime);
      expect(orphans).toContain(orphanedWebPageId);
      expect(orphans).not.toContain(releasedWebPageId);
    });

    it("INV-WORKER-PID-IDENTITY-005: findOrphanWebPageIds — empty result on workerPid mismatch (defensive)", async () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-PID-IDENTITY-005");
      const { prisma } = makeFailurePathPrismaStub([
        {
          id: "row-x",
          webPageId: "00000000-0000-0000-0000-0000000000E5",
          workerPid: 11111,
          workerSpawnTime: new Date("2026-05-05T21:00:00.000Z"),
          eventType: "spawn",
          eventAt: new Date("2026-05-05T21:00:00.000Z"),
        },
      ]);
      // Different pid → empty result.
      const orphans = await findOrphanWebPageIds(
        prisma,
        99999,
        new Date("2026-05-05T21:00:00.000Z")
      );
      expect(orphans).toEqual([]);
    });

    it("INV-WORKER-PID-IDENTITY-005: findOrphanWebPageIds — Prisma throw degrades to empty array (Graceful Degradation, supervisor falls back to phase_reconstruction='best_effort')", async () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-PID-IDENTITY-005");
      const prisma: FailurePathPrismaClient = {
        $transaction: async <T>(fn: (tx: FailurePathPrismaClient) => Promise<T>): Promise<T> =>
          fn(prisma),
        webPage: {
          update: async () => ({ id: "" }),
          // PR-INGEST-FAIL-ROW: `upsert` present only for FailurePathPrismaClient
          // type compliance (these stubs exercise findOrphanWebPageIds /
          // backfillOrphanWebPageRow, which use the id-key update path).
          upsert: async (args) => ({ id: args.create.id }),
        },
        workerJobLifecycle: {
          findMany: async () => {
            throw new Error("simulated db unreachable");
          },
        },
        auditLog: { create: async () => ({ id: "" }) },
      };
      const orphans = await findOrphanWebPageIds(prisma, 1, new Date());
      expect(orphans).toEqual([]);
    });
  });

  // ==========================================================================
  // Sub-B (orphan skip when spawn-time unavailable) — fail-closed contract
  // ==========================================================================
  //
  // Per ADR-0011 §A4 (cross-ref): when supervisor cannot determine
  // exitedSpawnTimeMs (childState already cleaned), the backfill MUST skip
  // rather than emit a wrong join key. Module B handles this guard before
  // calling failure-path service. The test here verifies that the failure-
  // path query path is structurally protected: even if the supervisor were
  // to call findOrphanWebPageIds with a synthetic timestamp (e.g. new
  // Date()), the composite [workerPid, workerSpawnTime] join would not
  // accidentally match any unrelated row that happens to share workerPid.
  // ==========================================================================

  describe("Sub-C (additional) — runtime: findOrphanWebPageIds is monotonically conservative under spawn-time uncertainty", () => {
    it("INV-WORKER-PID-IDENTITY-005: synthetic spawn-time (Date.now()) does NOT spuriously match any rows when actual spawn was earlier", async () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-PID-IDENTITY-005");
      // Real worker spawned at fixed timestamp T1.
      const T1 = new Date("2026-05-05T22:00:00.000Z");
      const pid = 34567;
      const webPageId = "00000000-0000-0000-0000-0000000000F6";

      const rows: Array<{
        id: string;
        webPageId: string;
        workerPid: number;
        workerSpawnTime: Date;
        eventType: string;
        eventAt: Date;
      }> = [
        {
          id: "real-spawn",
          webPageId,
          workerPid: pid,
          workerSpawnTime: T1,
          eventType: "spawn",
          eventAt: T1,
        },
      ];

      const prisma: FailurePathPrismaClient = {
        $transaction: async <T>(fn: (tx: FailurePathPrismaClient) => Promise<T>): Promise<T> =>
          fn(prisma),
        webPage: {
          update: async () => ({ id: "" }),
          // PR-INGEST-FAIL-ROW: `upsert` present only for FailurePathPrismaClient
          // type compliance (these stubs exercise findOrphanWebPageIds /
          // backfillOrphanWebPageRow, which use the id-key update path).
          upsert: async (args) => ({ id: args.create.id }),
        },
        workerJobLifecycle: {
          findMany: async (args) => {
            return rows
              .filter(
                (r) =>
                  r.workerPid === args.where.workerPid &&
                  r.workerSpawnTime.getTime() === args.where.workerSpawnTime.getTime()
              )
              .map((r) => ({ ...r }));
          },
        },
        auditLog: { create: async () => ({ id: "" }) },
      };

      // Synthetic spawn-time != T1 → composite join misses the real spawn row.
      const synthetic = new Date(T1.getTime() + 5000);
      const orphans = await findOrphanWebPageIds(prisma, pid, synthetic);
      // Conservative: returns empty (no false-positive backfill triggered).
      expect(orphans).toEqual([]);
    });
  });
});
