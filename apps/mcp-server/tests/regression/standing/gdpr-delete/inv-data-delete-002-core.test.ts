// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — gdpr-delete / INV-DATA-DELETE-002 core body
 *
 * INV-DATA-DELETE-002: `data.delete(target=page)` 実行により、3 秒以内に
 *   ADR-0016 § INV-DATA-DELETE-002 Assertion Contract の 5 項目独立 assertion
 *   が全て満たされる。Amendment 2-A で確定した **pgvector 11 tables**
 *   (9 page-linked embedding + 1 benchmark + 1 snapshot-cascade) が row=0 に
 *   到達、screenshot ファイルは `fs.existsSync === false`、audit_logs に
 *   GDPR Art.30 処理活動記録が 1 row 書かれる。
 *
 * Amendment 2-A 明記の out-of-scope (profile 経路 `deleteProfile`) テーブル
 *   `preference_profiles` / `preference_signals` は **絶対に削除されない**
 *   ことを negative assertion で確認する。
 *
 * INV-DATA-DELETE-002: Within 3 seconds, `data.delete(target=page)` must satisfy
 * all 5 independent assertions of ADR-0016 § INV-DATA-DELETE-002 Assertion
 * Contract. The 11 pgvector tables finalised in Amendment 2-A (9 page-linked
 * embedding + 1 benchmark + 1 snapshot-cascade) reach row=0, the screenshot
 * file is removed (`fs.existsSync === false`), and audit_logs receives one
 * GDPR Art.30 processing-activity record.
 *
 * Profile-path tables (`preference_profiles` / `preference_signals`) remain
 * intact — they belong to the `deleteProfile()` path and MUST NOT be touched.
 *
 * @see ADR-0016 § INV-DATA-DELETE-002 Assertion Contract
 * @see ADR-0016 Amendment 2-A pgvector 11 tables
 */

import * as fs from "node:fs";
import { describe, it, beforeAll, afterAll, beforeEach, expect } from "vitest";
import { PrismaClient } from "@prisma/client";

import { assertInvName } from "../_setup/inv-assert";
import {
  createTestPrismaClient,
  ensureSchemaAppliedOnce,
  seedGdprFixture,
  countPageVectorRows,
  countOutOfScopeProfileRows,
  truncateGdprDomainTables,
  type GdprFixtureIds,
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
// 3s SLA (ADR-0016 § INV-DATA-DELETE-002 Assertion Contract)
// ============================================================================

/**
 * GDPR Art.17 "without undue delay" の実務解釈として 3 秒を採用 (ADR-0016)。
 * 緩和提案は LCC sign-off 必須 (ADR-0016 § Amendment Process)。
 *
 * 3-second SLA per ADR-0016 interpretation of GDPR Art.17 "without undue delay".
 * Any relaxation proposal requires LCC sign-off (§ Amendment Process).
 *
 * Exported as the single SSOT for the 3s GDPR deletion SLA so sibling
 * gdpr-delete standing tests (e.g. INV-CROP-RETENTION-001 #4) pin the same
 * absolute contract without re-declaring the `3000` literal (CWE-209
 * truncateId SSOT-derive rigor parity, W6 Issue A PR-3b F-08).
 */
export const SLA_WITHIN_MS = 3000 as const;

// ============================================================================
// Module-scoped state (per-file DB client + DI wire-up shared across tests)
// ============================================================================

let prisma: PrismaClient;

describe("INV-DATA-DELETE-002: GDPR Art.17 5-item complete deletion within 3s", () => {
  beforeAll(async () => {
    // Domain-scoped schema apply (gdpr-delete 専用、process 内 1 回に絞る)。
    // Applied per-process; safe across multiple gdpr-delete test files.
    await ensureSchemaAppliedOnce(process.env.DATABASE_URL!);

    prisma = createTestPrismaClient();
    await prisma.$connect();

    // DI wire-up: 実 Prisma Client を 3 つのサービスに注入する。
    // Wire the real Prisma client into all three services via their DI factories.
    setGdprPrismaClientFactory(() => prisma as unknown as GdprPrismaClient);
    setAuditLogPrismaClientFactory(() => prisma as unknown as AuditLogPrismaClient);
    const screenshotSvc = createScreenshotPersistenceService({
      prisma: prisma as unknown as IScreenshotPersistencePrismaClient,
    });
    setGdprScreenshotPersistenceFactory(() => screenshotSvc);

    // GdprDeletionService instance + dataDeleteHandler の DI factory
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
    await truncateGdprDomainTables(prisma);
  });

  it(
    "INV-DATA-DELETE-002: data.delete deletes 11 pgvector tables + screenshot + writes audit_logs Art.30 record within 3s SLA",
    async () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-DATA-DELETE-002");

      // --- Seed fixture ---
      const ids: GdprFixtureIds = await seedGdprFixture(prisma);

      // Pre-assert: fixture が ADR-0016 Amendment 2-A の 11 tables に 1 row ずつ seed 済
      //            (quality_benchmarks は direct + indirect の二経路を明示 seed)
      // Pre-condition: 1 row each across 11 tables per Amendment 2-A
      //                (quality_benchmarks has both direct and indirect path).
      const beforeCounts = await countPageVectorRows(prisma, ids);
      expect(beforeCounts).toEqual({
        section_embeddings: 1,
        component_part_embeddings: 1,
        motion_embeddings: 1,
        js_animation_embeddings: 1,
        webgl_animation_embeddings: 1,
        motion_analysis_embeddings: 1,
        design_narrative_embeddings: 1,
        background_design_embeddings: 1,
        responsive_analysis_embeddings: 1,
        quality_benchmarks_direct: 1,
        quality_benchmarks_indirect: 1,
        design_snapshot_sections: 1,
      });
      expect(fs.existsSync(ids.screenshotPath)).toBe(true);

      // --- Execute data.delete(target=page) and measure 3s SLA (performance.now) ---
      const t0 = performance.now();
      const result = await dataDeleteHandler({
        target: "page",
        id: ids.webPageId,
        reason: "GDPR Art.17 — INV-DATA-DELETE-002 standing regression",
        confirm: true,
      });
      const elapsedMs = performance.now() - t0;

      // --- ADR § INV-DATA-DELETE-002 Assertion Contract: 5-item independent assertion ---

      // Sanity: handler returned success
      expect(result.success).toBe(true);

      // Item 1: web_pages row = 0
      const wpCount = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count FROM web_pages WHERE id = $1::uuid`,
        ids.webPageId
      );
      expect(Number(wpCount[0]!.count)).toBe(0);

      // Item 2: cascading parts/sections row = 0
      //   section_patterns は gdpr-deletion.service.ts が raw DELETE 実行
      //   component_parts は Prisma Cascade でも raw DELETE でも 0 になる
      //   (schema.prisma の onDelete: Cascade と service の明示削除の二重防御)
      const scCount = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count FROM section_patterns WHERE id = $1::uuid`,
        ids.sectionPatternId
      );
      expect(Number(scCount[0]!.count)).toBe(0);
      const cpCount = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count FROM component_parts WHERE id = $1::uuid`,
        ids.componentPartId
      );
      expect(Number(cpCount[0]!.count)).toBe(0);

      // Item 3: pgvector 11 tables (Amendment 2-A) all row = 0
      //   (9 embedding + quality_benchmarks 二経路 OR DELETE + design_snapshot_sections)
      const afterCounts = await countPageVectorRows(prisma, ids);
      expect(afterCounts).toEqual({
        section_embeddings: 0,
        component_part_embeddings: 0,
        motion_embeddings: 0,
        js_animation_embeddings: 0,
        webgl_animation_embeddings: 0,
        motion_analysis_embeddings: 0,
        design_narrative_embeddings: 0,
        background_design_embeddings: 0,
        responsive_analysis_embeddings: 0,
        quality_benchmarks_direct: 0,
        quality_benchmarks_indirect: 0,
        design_snapshot_sections: 0,
      });

      // Item 4: Screenshot filesystem + DB column
      //   (A) existsSync === false (brief INV-002-A)
      //   (B) screenshot DB column NULL (web_pages 行自体が削除された結果)
      expect(fs.existsSync(ids.screenshotPath)).toBe(false);

      // Item 5: audit_logs に action='data.delete' + result='success' が 1 row 書込済
      //   targetId は PII 配慮で truncateTargetId(8 + "...") 形式 (audit-log.service.ts:166)。
      //   先頭 8 文字 + "..." の prefix で LIKE match する。
      const truncatedPrefix = ids.webPageId.slice(0, 8);
      const auditRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count FROM audit_logs
         WHERE action = 'data.delete'
           AND target_type = 'web_page'
           AND result = 'success'
           AND target_id LIKE $1`,
        `${truncatedPrefix}%`
      );
      expect(Number(auditRows[0]!.count)).toBe(1);

      // --- Amendment 2-A: out-of-scope (profile 経路) negative assertion ---
      //   preference_profiles / preference_signals は data.delete(target=page) の対象外。
      //   absolute にここでは削除されないことを assert する。
      //   これは ADR-0016 Amendment 2-A で明記された契約境界。
      //
      //   Negative assertion: preference_profiles / preference_signals MUST remain.
      //   They are profile-path (`deleteProfile()`) scope per Amendment 2-A.
      const outOfScope = await countOutOfScopeProfileRows(prisma, ids);
      expect(outOfScope.preference_profiles).toBe(1);
      expect(outOfScope.preference_signals).toBe(1);

      // --- SLA: GDPR Art.17 "without undue delay" → 3 seconds (ADR-0016) ---
      // Log 実測値 (TDA sanity-check から測定値報告を要求されている)
      // Logs measured latency (TDA sanity-check requires reported values).
      console.log(
        `[INV-DATA-DELETE-002] 3s SLA measured: ${elapsedMs.toFixed(2)} ms (limit ${SLA_WITHIN_MS})`
      );
      expect(elapsedMs).toBeLessThan(SLA_WITHIN_MS);
    },
    // test-level timeout を SLA の 4 倍 (12s) に設定 — SLA assertion 失敗を vitest timeout で潰さない
    // Test timeout 4× the SLA so assertion failure is not masked by vitest timeout.
    SLA_WITHIN_MS * 4
  );
});
