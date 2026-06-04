// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — gdpr-delete / INV-DATA-DELETE-002 cascade extension
 *
 * INV-DATA-DELETE-002 cascade extension for `worker_job_lifecycle`
 * (Wave 3 UNBLOCK-V2-05b, LCC-FIND-01 closure)
 *
 * **Z-a Wave 3 dispatch / 配信契約**:
 *   - IO V2.1 Decision anchor `019df7ec-ce8d-7189-9a05-1f5c1f00efdf`
 *   - LCC-FIND-01 (M, test portion): Plan v3 Track T4 で導入された NEW
 *     `WorkerJobLifecycle` Prisma model に対し、GDPR Art.17 Right to Erasure
 *     cascade contract を standing regression として CI で fail する形で
 *     固定する。`onDelete: Cascade` (schema.prisma:1989) は schema 宣言だけ
 *     では将来の不可侵が保証されないため、削除パス全体 (data.delete handler
 *     → GdprDeletionService.deletePage → web_pages DELETE) を経由した cascade
 *     観測を CI 実行で固定する。
 *
 * **What this test pins / 固定する契約**:
 *   1. `data.delete(target=page, confirm=true)` 実行後、対象 `web_pages` 行に
 *      紐づく **すべての** `worker_job_lifecycle` 行が DB-level cascade で
 *      自動削除される (count = 0)。
 *   2. **同 process 内に存在する別 web_page 由来の lifecycle 行は影響を受けない**
 *      (cross-page lifecycle leak の negative assertion)。FK cascade が
 *      web_page_id の identity でのみ trigger することを確認。
 *   3. INV-DATA-DELETE-002 既存契約 (web_pages row=0 / audit_logs Art.30
 *      record / SLA 3s) は preserved。本 file は **cascade 拡張** のみを
 *      assert し、既存の 11 pgvector tables / screenshot は core test に委譲。
 *
 * **Why this complements core test / core test との補完関係**:
 *   - `inv-data-delete-002-core.test.ts` は ADR-0016 Amendment 2-A で
 *     確定した **11 pgvector tables** + screenshot + audit_logs を assert する。
 *   - 本 file は T4 (Plan v3 Track 4) で **新規追加** された `worker_job_lifecycle`
 *     table の cascade 経路を独立 assert する。core test に rows を増やす
 *     代わりに、separate file で seed/assert/cross-page negative assertion
 *     を完結させ、(a) regression scope を localize し、(b) core test の SLA
 *     timing measurement に新 table seeding が干渉しないようにする。
 *
 * **GDPR Art.17 cascade contract / GDPR Art.17 cascade 契約**:
 *   - `worker_job_lifecycle` rows は LCC M-01 で operational lifecycle data
 *     (NOT personal data) と分類されたが、`web_pages` 削除時には観測経路上
 *     の関連レコードとして同期削除される (Art.5(1)(c) data minimisation).
 *   - schema.prisma:1989 `onDelete: Cascade` 宣言が schema-level の唯一の
 *     enforcement 経路であり、`gdpr-deletion.service.ts` deletePage() は
 *     `worker_job_lifecycle` を **明示削除しない** — Prisma ORM の cascade
 *     のみで全 rows が drop される。本 test は schema cascade declaration が
 *     production migration で正しく適用されていることも間接的に保証する。
 *
 * **CI failure semantic / CI 失敗時の意味**:
 *   - cascade NOT enforced (例: schema regression で `onDelete: Cascade` 削除、
 *     migration drift) → assertion failure with descriptive error pointing at
 *     `WorkerJobLifecycle.webPageId` FK declaration in `schema.prisma:1989`.
 *   - cross-page lifecycle leak (FK declaration が誤って scope 過大) →
 *     negative assertion failure with clear scoping diagnostics.
 *
 * **pass^3 contract**: 3 consecutive PASS required per
 * `.claude/rules/testing-requirements.md` § Standing Regression Suite.
 *
 * @see ADR-0016 § INV-DATA-DELETE-002 Assertion Contract (core 11 tables)
 * @see Plan v3 Track T4 §5.1 (NEW WorkerJobLifecycle table)
 * @see `packages/database/prisma/schema.prisma:1975-1994` (Prisma model)
 * @see `packages/database/prisma/migrations/20260505050756_t4_worker_job_lifecycle/`
 * @see `pr-v3-t4-finding-registry-v1.md` §6.2 UNBLOCK-V2-05b (Wave 3 closure)
 * @see IO V2.1 Decision internal anchor `019df7ec-ce8d-7189-9a05-1f5c1f00efdf`
 * @module tests/regression/standing/gdpr-delete/inv-data-delete-002-worker-job-lifecycle-cascade
 */

import * as crypto from "node:crypto";
import { describe, it, beforeAll, afterAll, beforeEach, expect } from "vitest";
import { PrismaClient } from "@prisma/client";

import { assertInvName } from "../_setup/inv-assert";
import {
  createTestPrismaClient,
  ensureSchemaAppliedOnce,
  truncateGdprDomainTables,
} from "../_setup/gdpr-test-fixtures";
import {
  dataDeleteHandler,
  setDataDeleteServiceFactory,
  resetDataDeleteServiceFactory,
} from "../../../../src/tools/data/data.tool";
import {
  GdprDeletionService,
  setGdprPrismaClientFactory,
  resetGdprPrismaClientFactory,
  setGdprScreenshotPersistenceFactory,
  resetGdprScreenshotPersistenceFactory,
  resetGdprDeletionService,
  type GdprPrismaClient,
} from "../../../../src/services/gdpr-deletion.service";
import {
  setAuditLogPrismaClientFactory,
  resetAuditLogPrismaClientFactory,
  resetAuditLogService,
  type AuditLogPrismaClient,
} from "../../../../src/services/audit-log.service";
import {
  createScreenshotPersistenceService,
  type IScreenshotPersistencePrismaClient,
} from "../../../../src/services/screenshot-persistence.service";

// ============================================================================
// Module-scoped state (per-file DB client + DI wire-up shared across tests)
// ============================================================================

let prisma: PrismaClient;

// ============================================================================
// Local fixture helpers (cascade-test scoped)
// ============================================================================

interface CascadeFixtureIds {
  /** Target web_page (will be deleted by data.delete) */
  targetWebPageId: string;
  /** Target's worker_job_lifecycle row IDs (must all cascade to 0) */
  targetLifecycleIds: string[];
  /** Untouched bystander web_page (must remain) */
  bystanderWebPageId: string;
  /** Bystander's lifecycle row ID (must NOT be deleted) */
  bystanderLifecycleId: string;
}

/**
 * Seed a target page + 3 lifecycle rows + a bystander page + 1 lifecycle row.
 *
 * 3 lifecycle rows for the target give the cascade more than one row to delete,
 * making the assertion empirically verifiable (not a vacuous truth on 0 rows).
 *
 * The bystander page + its lifecycle row anchors the negative cross-page
 * assertion: only the target's rows must cascade.
 */
async function seedCascadeFixture(client: PrismaClient): Promise<CascadeFixtureIds> {
  const ids: CascadeFixtureIds = {
    targetWebPageId: crypto.randomUUID(),
    targetLifecycleIds: [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()],
    bystanderWebPageId: crypto.randomUUID(),
    bystanderLifecycleId: crypto.randomUUID(),
  };

  // Target web_page row (will be deleted by data.delete handler).
  await client.$executeRawUnsafe(
    `INSERT INTO web_pages (id, url, source_type, usage_scope, updated_at)
     VALUES ($1::uuid, $2, 'user_provided', 'inspiration_only', NOW())`,
    ids.targetWebPageId,
    `https://example.com/cascade-target/${ids.targetWebPageId}`
  );

  // Target's 3 lifecycle rows: spawn / release / restart event sequence.
  // worker_pid + worker_spawn_time pair is the supplementary identity used by
  // INV-WORKER-PID-IDENTITY-005 Sub-C (cross-PID-reuse defense).
  const targetSpawnTime = new Date(Date.now() - 60_000).toISOString();
  const events: Array<"spawn" | "release" | "restart"> = ["spawn", "release", "restart"];
  for (let i = 0; i < ids.targetLifecycleIds.length; i++) {
    await client.$executeRawUnsafe(
      `INSERT INTO worker_job_lifecycle
         (id, web_page_id, worker_pid, worker_spawn_time, worker_type, event_type, nonce)
       VALUES ($1::uuid, $2::uuid, $3, $4::timestamptz, 'page'::"WorkerType",
               $5::"WorkerLifecycleEvent", $6::uuid)`,
      ids.targetLifecycleIds[i]!,
      ids.targetWebPageId,
      12345,
      targetSpawnTime,
      events[i]!,
      crypto.randomUUID()
    );
  }

  // Bystander web_page (NOT touched by data.delete; cross-page negative assertion).
  await client.$executeRawUnsafe(
    `INSERT INTO web_pages (id, url, source_type, usage_scope, updated_at)
     VALUES ($1::uuid, $2, 'user_provided', 'inspiration_only', NOW())`,
    ids.bystanderWebPageId,
    `https://example.com/cascade-bystander/${ids.bystanderWebPageId}`
  );

  // Bystander's lifecycle row (must remain after target cascade).
  await client.$executeRawUnsafe(
    `INSERT INTO worker_job_lifecycle
       (id, web_page_id, worker_pid, worker_spawn_time, worker_type, event_type, nonce)
     VALUES ($1::uuid, $2::uuid, $3, $4::timestamptz, 'page'::"WorkerType",
             'spawn'::"WorkerLifecycleEvent", $5::uuid)`,
    ids.bystanderLifecycleId,
    ids.bystanderWebPageId,
    67890,
    new Date(Date.now() - 30_000).toISOString(),
    crypto.randomUUID()
  );

  return ids;
}

async function countLifecycleRowsForPage(client: PrismaClient, webPageId: string): Promise<number> {
  const rows = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM worker_job_lifecycle WHERE web_page_id = $1::uuid`,
    webPageId
  );
  return Number(rows[0]?.count ?? 0n);
}

async function countLifecycleRowById(client: PrismaClient, id: string): Promise<number> {
  const rows = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM worker_job_lifecycle WHERE id = $1::uuid`,
    id
  );
  return Number(rows[0]?.count ?? 0n);
}

// ============================================================================
// Test
// ============================================================================

describe("INV-DATA-DELETE-002: worker_job_lifecycle cascade extension (Wave 3 UNBLOCK-V2-05b)", () => {
  beforeAll(async () => {
    await ensureSchemaAppliedOnce(process.env.DATABASE_URL!);

    prisma = createTestPrismaClient();
    await prisma.$connect();

    setGdprPrismaClientFactory(() => prisma as unknown as GdprPrismaClient);
    setAuditLogPrismaClientFactory(() => prisma as unknown as AuditLogPrismaClient);
    const screenshotSvc = createScreenshotPersistenceService({
      prisma: prisma as unknown as IScreenshotPersistencePrismaClient,
    });
    setGdprScreenshotPersistenceFactory(() => screenshotSvc);

    const gdprSvc = new GdprDeletionService();
    setDataDeleteServiceFactory(() => gdprSvc);
  });

  afterAll(async () => {
    resetDataDeleteServiceFactory();
    resetGdprPrismaClientFactory();
    resetGdprScreenshotPersistenceFactory();
    resetAuditLogPrismaClientFactory();
    resetGdprDeletionService();
    resetAuditLogService();
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    // Truncate domain tables AND worker_job_lifecycle (not in core helper since
    // worker_job_lifecycle was added by Plan v3 Track T4 after the core helper).
    // CASCADE clause covers worker_job_lifecycle via web_pages FK cascade.
    await truncateGdprDomainTables(prisma);
    // Belt-and-suspenders: explicit truncate for orphan defense (lifecycle rows
    // whose web_pages parent is already gone are unreachable via web_pages
    // cascade and would survive the previous truncate).
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE worker_job_lifecycle RESTART IDENTITY CASCADE`);
  });

  it("INV-DATA-DELETE-002: data.delete(target=page) cascades worker_job_lifecycle rows via onDelete: Cascade FK + leaves bystander page lifecycle untouched / data.delete cascade契約 + cross-page bystander 不変", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-DATA-DELETE-002");

    // --- Seed: target page (3 lifecycle rows) + bystander page (1 lifecycle row) ---
    const ids = await seedCascadeFixture(prisma);

    // Pre-condition: target has 3 lifecycle rows, bystander has 1 lifecycle row.
    expect(await countLifecycleRowsForPage(prisma, ids.targetWebPageId)).toBe(3);
    expect(await countLifecycleRowsForPage(prisma, ids.bystanderWebPageId)).toBe(1);
    expect(await countLifecycleRowById(prisma, ids.bystanderLifecycleId)).toBe(1);

    // --- Execute data.delete(target=page) ---
    const result = await dataDeleteHandler({
      target: "page",
      id: ids.targetWebPageId,
      reason: "GDPR Art.17 — INV-DATA-DELETE-002 Wave 3 cascade extension (worker_job_lifecycle)",
      confirm: true,
    });

    expect(result.success).toBe(true);

    // --- Cascade contract assertions ---

    // (1) Target web_page row gone (sanity, parent of cascade).
    const wpCount = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM web_pages WHERE id = $1::uuid`,
      ids.targetWebPageId
    );
    expect(Number(wpCount[0]!.count)).toBe(0);

    // (2) ALL of target's worker_job_lifecycle rows cascaded to 0.
    //     This is the core UNBLOCK-V2-05b contract: schema.prisma:1989
    //     `onDelete: Cascade` MUST remove every lifecycle row sharing
    //     web_page_id with the deleted web_pages parent.
    expect(await countLifecycleRowsForPage(prisma, ids.targetWebPageId)).toBe(0);
    for (const lifecycleId of ids.targetLifecycleIds) {
      expect(await countLifecycleRowById(prisma, lifecycleId)).toBe(0);
    }

    // (3) Bystander web_page row REMAINS (cross-page negative assertion).
    //     If FK cascade scope is misdeclared (e.g., overly broad), this
    //     would be 0 and we would catch the regression.
    const bystanderWpCount = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM web_pages WHERE id = $1::uuid`,
      ids.bystanderWebPageId
    );
    expect(Number(bystanderWpCount[0]!.count)).toBe(1);

    // (4) Bystander's worker_job_lifecycle row REMAINS (cross-page negative).
    expect(await countLifecycleRowsForPage(prisma, ids.bystanderWebPageId)).toBe(1);
    expect(await countLifecycleRowById(prisma, ids.bystanderLifecycleId)).toBe(1);

    // (5) audit_logs Art.30 record was emitted for the deletion (re-asserted
    //     here so this file's contract is self-contained — the core test
    //     already asserts this for the 11-table path, but Wave 3's contract
    //     specifies cross-cutting Art.30 atomicity for ANY data.delete run).
    const truncatedPrefix = ids.targetWebPageId.slice(0, 8);
    const auditRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM audit_logs
       WHERE action = 'data.delete'
         AND target_type = 'web_page'
         AND result = 'success'
         AND target_id LIKE $1`,
      `${truncatedPrefix}%`
    );
    expect(Number(auditRows[0]!.count)).toBe(1);
  });
});
