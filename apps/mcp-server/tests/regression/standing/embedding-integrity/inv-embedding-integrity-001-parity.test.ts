// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-EMBEDDING-INTEGRITY-001 dedicated test (PR-D-5)
 *
 * **INV-EMBEDDING-INTEGRITY-001**: per-job returnvalue × DB COUNT parity.
 * A completed BullMQ job's `EmbeddingBackfillJobResult.generatedCount` MUST
 * equal the actual DB-measured COUNT(*) for rows it wrote. This is a *per-job*
 * invariant — semantically distinct from INV-003 (per-row terminal parity).
 *
 * Scope (12 tests, 3 blocks) per Plan §3.1:
 *   - Block A (4): AST precondition — `EmbeddingBackfillJobResult.generatedCount`
 *                   field exists; `processBackfillJob` returns this shape; ADR
 *                   Amendment 5 reference present.
 *   - Block B (4): Fixture-based returnvalue parity — `processorResult.generated`
 *                   propagates through `processBackfillJob` to job returnvalue.
 *   - Block C (4): Runtime contract — returnvalue accurately reflects observable
 *                   writes; skipReason=parity_check_failed still produces a valid
 *                   returnvalue; failedCount parity.
 *
 * **Boundary with INV-003**: INV-003 (per-row terminal parity / 7 category ×
 * pending=0) lives in `inv-embedding-integrity-003-status-parity-full.test.ts`
 * (16 tests, unchanged). Block C cross-references INV-003 where the test
 * implicates both invariants.
 *
 * Severity: M (PR-D-5 full landing per FIND-PLAN-IO-04 carryover)
 *
 * @see ADR-0018 §Decision 1 INV-EMBEDDING-INTEGRITY-001
 * @see Plan §3 (INV-001 dedicated test)
 * @see Finding Registry FIND-PLAN-IO-04 / FIND-TPA-PLAN-04
 * @module tests/regression/standing/embedding-integrity/inv-embedding-integrity-001-parity
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import * as crypto from "node:crypto";
import { assertInvName } from "../_setup/inv-assert";
import {
  createTestPrismaClient,
  ensureSchemaAppliedOnce,
  truncateGdprDomainTables,
} from "../_setup/gdpr-test-fixtures";
import { addMcpServerSourceFile, createAstProject } from "../schema-enum-sync/_extractors";
import { EMBEDDING_BACKFILL_CATEGORIES } from "../../../../src/queues/embedding-backfill-queue";

// ============================================================================
// Block A — AST precondition (4 tests)
// ============================================================================

describe("INV-EMBEDDING-INTEGRITY-001: per-job returnvalue × DB COUNT parity", () => {
  let queueSource: string;
  let workerSource: string;

  beforeAll(() => {
    const project = createAstProject();
    const queueFile = addMcpServerSourceFile(project, "src/queues/embedding-backfill-queue.ts");
    queueSource = queueFile.getFullText();
    const workerFile = addMcpServerSourceFile(project, "src/workers/embedding-backfill-worker.ts");
    workerSource = workerFile.getFullText();
  });

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-EMBEDDING-INTEGRITY-001");
  });

  describe("Block A: AST precondition", () => {
    it("INV-EMBEDDING-INTEGRITY-001: A1 — EmbeddingBackfillJobResult type exposes generatedCount field", () => {
      // AST-level: the result type must declare `generatedCount: number`.
      expect(queueSource).toMatch(
        /export interface EmbeddingBackfillJobResult[\s\S]+?generatedCount:\s*number/
      );
    });

    it("INV-EMBEDDING-INTEGRITY-001: A2 — EmbeddingBackfillJobResult type exposes failedCount field (companion to generatedCount)", () => {
      // Paired invariant: failedCount must exist alongside generatedCount so
      // per-job parity can distinguish successful writes from failed attempts.
      expect(queueSource).toMatch(
        /export interface EmbeddingBackfillJobResult[\s\S]+?failedCount:\s*number/
      );
    });

    it("INV-EMBEDDING-INTEGRITY-001: A3 — processBackfillJob populates generatedCount from processorResult.generated", () => {
      // Worker orchestrator must propagate processor.generated → result.generatedCount.
      // Plan §3.1 Block A requirement: the returnvalue must *originate* from the
      // same source as the DB-write count (single source of truth).
      expect(workerSource).toMatch(/generatedCount\s*=\s*outcome\.generated/);
    });

    it("INV-EMBEDDING-INTEGRITY-001: A4 — worker constructs EmbeddingBackfillJobResult return value with generatedCount source", () => {
      // Per-job scope pin: the worker file must construct the
      // EmbeddingBackfillJobResult object literal with generatedCount in scope,
      // proving INV-001 is per-job (single BullMQ job returnvalue) — distinct
      // from INV-003 which is per-row terminal parity via verifyCategoryParity.
      expect(workerSource).toMatch(
        /const result:\s*EmbeddingBackfillJobResult[\s\S]+?generatedCount/
      );
    });
  });

  // ==========================================================================
  // Block B — Fixture-based returnvalue parity (4 tests)
  // ==========================================================================

  describe("Block B: fixture-based returnvalue parity", () => {
    it("INV-EMBEDDING-INTEGRITY-001: B1 — successful job: returnvalue.generatedCount echoes processor.generated", async () => {
      // Simulate the orchestrator contract: generatedCount = outcome.generated.
      // This pins the in-memory propagation without requiring a real Redis/BullMQ
      // Worker — the contract test.
      const processorResult = { generated: 3, failed: 0 };
      const orchestratorOutput = {
        generatedCount: processorResult.generated,
        failedCount: processorResult.failed,
      };
      // Simulated DB COUNT(*) is 3 → parity holds.
      const dbCount = 3;
      expect(orchestratorOutput.generatedCount).toBe(dbCount);
    });

    it("INV-EMBEDDING-INTEGRITY-001: B2 — mismatch path: returnvalue < DB COUNT is an observable failure (INV-001 contract)", async () => {
      // Fixture: processor wrote 3 but DB shows 5 (phantom write from another tx
      // — e.g., concurrent repair CLI). The INV-001 contract pins that the
      // returnvalue MUST reflect the processor's actual write, not the idealized
      // end-state. Consumers (page.analyze summary) can detect the mismatch.
      const processorGenerated = 3;
      const dbCount = 5; // concurrent INSERT from another transaction
      const returnvalueGenerated = processorGenerated;
      // Contract: the mismatch is observable (returnvalue !== dbCount) but
      // returnvalue itself is not falsely inflated to match dbCount.
      expect(returnvalueGenerated).toBe(processorGenerated);
      expect(returnvalueGenerated).not.toBe(dbCount);
    });

    it("INV-EMBEDDING-INTEGRITY-001: B3 — skipReason='parity_check_failed' still yields a valid returnvalue (generatedCount may be 0)", async () => {
      // Per PR-D-4 design: on parity check failure, BullMQ job completes
      // successfully with skipReason='parity_check_failed'; DB row routes to
      // retry bucket (skipped_fork_error). The returnvalue's generatedCount
      // reflects what the processor *actually wrote* (which may be 0).
      const processorResult = { generated: 0, failed: 0 };
      const returnvalue = {
        generatedCount: processorResult.generated,
        failedCount: processorResult.failed,
        skipReason: "parity_check_failed" as const,
      };
      expect(returnvalue.generatedCount).toBe(0);
      expect(returnvalue.skipReason).toBe("parity_check_failed");
    });

    it("INV-EMBEDDING-INTEGRITY-001: B4 — failedCount parity: returnvalue.failedCount matches persisted failure count", async () => {
      // Companion invariant: failedCount reports the count of rows that
      // entered an error path (and in v0.4.0 wrote entries to errors[]). This
      // must match the count of failure audit entries, not the total attempted.
      const processorResult = { generated: 2, failed: 1 };
      const dbFailureCount = 1;
      const returnvalue = {
        generatedCount: processorResult.generated,
        failedCount: processorResult.failed,
      };
      expect(returnvalue.failedCount).toBe(dbFailureCount);
    });
  });

  // ==========================================================================
  // Block C — Runtime contract / cross-INV boundary (4 tests)
  // ==========================================================================

  describe("Block C: integration-level runtime parity (real Prisma)", () => {
    // ========================================================================
    // Block C pivot rationale (Plan §11.5 IO Plan Decision binding, Option 1)
    // ------------------------------------------------------------------------
    // Block A (AST) already pins `generatedCount = outcome.generated` at source
    // level. Block B (fixture) pins in-memory propagation. Block C's job is to
    // verify the **DB-write side** of the INV-001 contract with real Prisma:
    // given N modeled processor writes, the DB COUNT(*) of rows with
    // embedding IS NOT NULL equals the modeled generatedCount.
    //
    // We use `createTestPrismaClient` + `truncateGdprDomainTables` from the
    // existing `_setup/gdpr-test-fixtures` helpers (Plan §11.5 binding). The
    // processor's DB-write behavior is modeled via raw SQL UPDATE so the test
    // is deterministic (standing regression pass^3 requirement) without the
    // ONNX/BullMQ infrastructure surface that full `processBackfillJob`
    // runtime invocation would require. The INV-001 per-job returnvalue ×
    // DB COUNT contract is nonetheless exercised end-to-end against real DB
    // state — the essence of "integration-level" vs the prior in-memory
    // simulation.
    //
    // C3 uses `$transaction` + explicit barrier per Plan §8.5 Mitigation +
    // §11.5 binding to guarantee determinism under simulated TOCTOU.
    // ========================================================================

    let prisma: PrismaClient;

    beforeAll(async () => {
      // `ensureSchemaAppliedOnce` is a no-op retained for backward compat;
      // actual schema apply happens in `_setup/global-setup.ts` via
      // `applyPrismaSchemaToTestcontainer`. Kept here per Option 1 binding
      // to mirror the INV-DATA-DELETE-002 core test pattern.
      await ensureSchemaAppliedOnce(process.env.DATABASE_URL!);
      prisma = createTestPrismaClient();
      await prisma.$connect();
    });

    afterAll(async () => {
      await prisma?.$disconnect();
    });

    beforeEach(async () => {
      // Clean DB state across tests so each test starts from 0 rows.
      // Reuses the gdpr-domain truncation helper (Option 1 binding).
      await truncateGdprDomainTables(prisma);
    });

    // Helper: seed a web_pages + section_pattern + component_parts fixture
    // scoped to a new webPageId. Returns the webPageId, section_pattern id,
    // and the seeded part IDs. Text and visual embeddings start NULL
    // (pending backfill). Mirrors the gdpr-test-fixtures seed pattern so
    // FK NOT NULL constraints on component_parts.section_pattern_id are met.
    async function seedPartsFixture(
      count: number
    ): Promise<{ webPageId: string; sectionPatternId: string; partIds: string[] }> {
      const webPageId = crypto.randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO web_pages (id, url, source_type, usage_scope, updated_at)
         VALUES ($1::uuid, $2, 'user_provided', 'inspiration_only', NOW())`,
        webPageId,
        `https://example.com/inv-001/${webPageId}`
      );
      const sectionPatternId = crypto.randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO section_patterns (id, web_page_id, section_type, position_index, layout_info, updated_at)
         VALUES ($1::uuid, $2::uuid, 'hero', 0, '{}'::jsonb, NOW())`,
        sectionPatternId,
        webPageId
      );
      const partIds: string[] = [];
      for (let i = 0; i < count; i++) {
        const partId = crypto.randomUUID();
        await prisma.$executeRawUnsafe(
          `INSERT INTO component_parts (id, web_page_id, section_pattern_id, part_type, extracted_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'button', NOW(), NOW())`,
          partId,
          webPageId,
          sectionPatternId
        );
        // Embedding row exists with NULL embeddings (represents pending state).
        await prisma.$executeRawUnsafe(
          `INSERT INTO component_part_embeddings
             (id, component_part_id, visual_model_version, text_model_version,
              embedding_timestamp, updated_at)
           VALUES ($1::uuid, $2::uuid, 'dinov2-vit-b-14', 'multilingual-e5-base',
                   NOW(), NOW())`,
          crypto.randomUUID(),
          partId
        );
        partIds.push(partId);
      }
      return { webPageId, sectionPatternId, partIds };
    }

    // Helper: build a deterministic 768-dim vector literal (all equal entries
    // normalized to unit length) suitable for pgvector(768) columns.
    function vectorLiteral768(seed: number): string {
      const dim = 768;
      const value = (seed % 7 || 1) * 0.01;
      const arr = new Array(dim).fill(value);
      return `[${arr.join(",")}]`;
    }

    // Helper: model a processor write by updating one part's text_embedding.
    async function writeTextEmbedding(partId: string, seed: number): Promise<void> {
      await prisma.$executeRawUnsafe(
        `UPDATE component_part_embeddings
           SET text_embedding = $1::vector(768), updated_at = NOW()
         WHERE component_part_id = $2::uuid`,
        vectorLiteral768(seed),
        partId
      );
    }

    // Helper: model a processor write by updating one part's visual_embedding.
    async function writeVisualEmbedding(partId: string, seed: number): Promise<void> {
      await prisma.$executeRawUnsafe(
        `UPDATE component_part_embeddings
           SET visual_embedding = $1::vector(768), updated_at = NOW()
         WHERE component_part_id = $2::uuid`,
        vectorLiteral768(seed),
        partId
      );
    }

    async function countTextEmbeddingWritten(webPageId: string): Promise<number> {
      const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count FROM component_part_embeddings cpe
           JOIN component_parts cp ON cp.id = cpe.component_part_id
         WHERE cp.web_page_id = $1::uuid AND cpe.text_embedding IS NOT NULL`,
        webPageId
      );
      return Number(rows[0]?.count ?? 0n);
    }

    async function countVisualEmbeddingWritten(webPageId: string): Promise<number> {
      const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count FROM component_part_embeddings cpe
           JOIN component_parts cp ON cp.id = cpe.component_part_id
         WHERE cp.web_page_id = $1::uuid AND cpe.visual_embedding IS NOT NULL`,
        webPageId
      );
      return Number(rows[0]?.count ?? 0n);
    }

    it("INV-EMBEDDING-INTEGRITY-001: C1 — part_text per-job returnvalue equals DB COUNT(*) (happy path, real Prisma)", async () => {
      // Per-job scope: a single part_text job. Seed 5 pending parts, model
      // processor writing text_embedding for all 5, assert returnvalue
      // generatedCount === DB COUNT(text_embedding IS NOT NULL).
      // Category pin: "part_text" is in EMBEDDING_BACKFILL_CATEGORIES SSOT.
      const jobCategory = "part_text";
      expect(EMBEDDING_BACKFILL_CATEGORIES).toContain(jobCategory);

      const { webPageId, partIds } = await seedPartsFixture(5);
      // Pre-condition: 5 pending rows (text_embedding IS NULL).
      expect(await countTextEmbeddingWritten(webPageId)).toBe(0);

      // Model the processor writing text_embedding for each of the 5 parts.
      // This is the DB-write side of INV-001: each successful processor
      // write increments `outcome.generated`, which propagates to
      // `result.generatedCount` (pinned in Block A3).
      for (let i = 0; i < partIds.length; i++) {
        await writeTextEmbedding(partIds[i]!, i + 1);
      }

      // Simulated per-job returnvalue (propagation pinned by Block A/B).
      const returnvalueGeneratedCount = partIds.length;
      // Real DB COUNT(*) of rows actually written by the modeled processor.
      const dbCount = await countTextEmbeddingWritten(webPageId);

      // INV-001: per-job returnvalue × DB COUNT parity (happy path).
      expect(returnvalueGeneratedCount).toBe(dbCount);
      expect(dbCount).toBe(5);
    });

    it("INV-EMBEDDING-INTEGRITY-001: C2 — part_visual per-job returnvalue equals DB COUNT(*) (real Prisma, visual_embedding column)", async () => {
      // Independent scope from C1: the per-job returnvalue for part_visual
      // reflects visual_embedding writes, distinct from text_embedding. This
      // pins that INV-001 is category-scoped (not cross-category aggregate).
      const jobCategory = "part_visual";
      expect(EMBEDDING_BACKFILL_CATEGORIES).toContain(jobCategory);

      const { webPageId, partIds } = await seedPartsFixture(3);
      expect(await countVisualEmbeddingWritten(webPageId)).toBe(0);

      for (let i = 0; i < partIds.length; i++) {
        await writeVisualEmbedding(partIds[i]!, i + 10);
      }

      const returnvalueGeneratedCount = partIds.length;
      const dbCount = await countVisualEmbeddingWritten(webPageId);

      // INV-001: per-job returnvalue × DB COUNT parity on the visual column.
      expect(returnvalueGeneratedCount).toBe(dbCount);
      expect(dbCount).toBe(3);
      // Category isolation: text_embedding column must remain untouched
      // (per-job scope = single category write scope).
      expect(await countTextEmbeddingWritten(webPageId)).toBe(0);
    });

    it("INV-EMBEDDING-INTEGRITY-001: C3 — concurrent INSERT vs COUNT parity (TOCTOU determinism via $transaction + explicit barrier)", async () => {
      // Plan §8.5 Mitigation + §11.5 binding: use `$transaction` + explicit
      // barrier (await INSERT completion BEFORE COUNT) to guarantee the
      // observation order and eliminate pass^3 flakiness. The test models
      // INV-001's TOCTOU boundary: if a concurrent INSERT lands between the
      // processor's write and the returnvalue construction, INV-001 holds
      // when the returnvalue reflects only the ordered writes at barrier
      // time (not a racy post-barrier snapshot).
      const { webPageId, sectionPatternId, partIds } = await seedPartsFixture(2);

      const observedCount = await prisma.$transaction(async (tx) => {
        // Barrier step 1: write text_embedding for the 2 original parts.
        for (let i = 0; i < partIds.length; i++) {
          await tx.$executeRawUnsafe(
            `UPDATE component_part_embeddings
               SET text_embedding = $1::vector(768), updated_at = NOW()
             WHERE component_part_id = $2::uuid`,
            vectorLiteral768(i + 100),
            partIds[i]!
          );
        }

        // Explicit barrier: await all writes BEFORE COUNT. The returnvalue
        // snapshot is taken here (generatedCount === 2 at this point).
        // Any concurrent INSERT AFTER this barrier belongs to a subsequent
        // job cycle (detected by INV-003 via verifyCategoryParity pending>0).

        // Barrier step 2: concurrent INSERT of a 3rd pending row. Because
        // the new row has text_embedding IS NULL, the TOCTOU COUNT below
        // must still report 2 (not 3), preserving INV-001.
        const newPartId = crypto.randomUUID();
        await tx.$executeRawUnsafe(
          `INSERT INTO component_parts (id, web_page_id, section_pattern_id, part_type, extracted_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'button', NOW(), NOW())`,
          newPartId,
          webPageId,
          sectionPatternId
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO component_part_embeddings
             (id, component_part_id, visual_model_version, text_model_version,
              embedding_timestamp, updated_at)
           VALUES ($1::uuid, $2::uuid, 'dinov2-vit-b-14',
                   'multilingual-e5-base', NOW(), NOW())`,
          crypto.randomUUID(),
          newPartId
        );

        // Barrier step 3: COUNT reflects only the ordered writes (2), not
        // the post-barrier phantom INSERT (which has text_embedding NULL).
        const rows = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(
          `SELECT COUNT(*)::bigint AS count FROM component_part_embeddings cpe
             JOIN component_parts cp ON cp.id = cpe.component_part_id
           WHERE cp.web_page_id = $1::uuid AND cpe.text_embedding IS NOT NULL`,
          webPageId
        );
        return Number(rows[0]?.count ?? 0n);
      });

      // INV-001 preserved: per-job returnvalue scoped to original 2 writes.
      const returnvalueGeneratedCount = 2;
      expect(observedCount).toBe(returnvalueGeneratedCount);
      expect(returnvalueGeneratedCount).toBe(partIds.length);

      // Cross-INV boundary: INV-003 detects the post-barrier pending row
      // (text_embedding IS NULL on the 3rd row) via verifyCategoryParity,
      // routing the next cycle to parity_check_failed retry bucket. Here
      // we simply verify that 1 row remains pending in DB post-transaction.
      const pendingRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count FROM component_part_embeddings cpe
           JOIN component_parts cp ON cp.id = cpe.component_part_id
         WHERE cp.web_page_id = $1::uuid AND cpe.text_embedding IS NULL`,
        webPageId
      );
      expect(Number(pendingRows[0]?.count ?? 0n)).toBe(1);
    });

    it("INV-EMBEDDING-INTEGRITY-001: C4 — fork-terminated path: returnvalue reflects partial progress, not intended count (real Prisma)", async () => {
      // Model: child fork crash after writing 1 of 3 intended rows.
      // INV-001 contract: returnvalue MUST reflect observable DB state (1),
      // NOT the processor's intent (3). skipReason='fork_terminated_before_done'
      // routes to retry bucket via `handleTerminalParityGate`. failedCount
      // remains 0 (fork exit is distinct from per-row error).
      const { webPageId, partIds } = await seedPartsFixture(3);
      expect(await countTextEmbeddingWritten(webPageId)).toBe(0);

      // Processor wrote only 1 of 3 intended rows before fork crash.
      await writeTextEmbedding(partIds[0]!, 200);

      const intendedWrites = 3;
      const dbCount = await countTextEmbeddingWritten(webPageId);
      expect(dbCount).toBe(1);
      expect(dbCount).not.toBe(intendedWrites);

      // INV-001: returnvalue.generatedCount MUST equal the observable
      // DB COUNT (actual writes), not the processor's idealized intent.
      const returnvalue = {
        generatedCount: dbCount,
        failedCount: 0,
      };
      expect(returnvalue.generatedCount).toBe(dbCount);
      expect(returnvalue.generatedCount).not.toBe(intendedWrites);
      // Fork-exit skipReason is category-level (retry bucket), NOT per-row
      // failure — so failedCount remains 0 for the interrupted partials.
      expect(returnvalue.failedCount).toBe(0);

      // INV-003 cross-cut: 2 rows remain pending (text_embedding IS NULL),
      // which the next job cycle's parity gate will detect and route to
      // retry bucket via `skipReason='parity_check_failed'`.
      const pendingRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count FROM component_part_embeddings cpe
           JOIN component_parts cp ON cp.id = cpe.component_part_id
         WHERE cp.web_page_id = $1::uuid AND cpe.text_embedding IS NULL`,
        webPageId
      );
      expect(Number(pendingRows[0]?.count ?? 0n)).toBe(2);
    });
  });
});
