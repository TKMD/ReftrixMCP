// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — large-page domain
 *
 * INV-BACKFILL-PART-RESIDUAL-MARKER-009 (PR-BT-4 / ADR-0018 Amendment 10
 * Decision 10.2; design V1 §4.3.1; gap B closure):
 *
 *   The backfill `PartVisualProcessor` residual bbox path
 *   (`resolveAndPersistBboxes` → `emitResidualBboxSkipAudit`, `skippedCount>0`)
 *   used to write only an `audit_logs` entry, never the per-row DB marker, so
 *   residual bbox-zero parts stayed `visual_embedding IS NULL AND
 *   visual_skip_reason IS NULL` = permanent pending (forced-`failed` after the
 *   60-min reconciliation cron). H-3 closes this gap with TWO contracts:
 *
 *   (Layer-1, positive) The residual path writes
 *   `component_part_embeddings.visual_skip_reason='bbox_unresolvable'` per-row
 *   markers (via the exported `markResidualBboxUnresolvableParts` reusing the
 *   idempotent `writePartVisualTerminalSkipMarker`), so each residual part is
 *   excluded by the SSOT `partVisualPendingExclusionPredicate` and the page can
 *   reach `completed`.
 *
 *   (Layer-2, NEGATIVE — TPA-H-01 / U2 dual-layer separation) The residual
 *   marker write MUST NOT propagate to the run-level skip channel. The REAL
 *   surface (NOT the comment-only `skipReasonToBackfillStatus`) is:
 *     - `PartVisualProcessor.resolveAndPersistBboxes` returns `null`
 *       (fall-through) for the residual case — it does NOT return a
 *       `BackfillCategoryResult` carrying `skipReason: "bbox_unresolvable"`;
 *     - therefore `initiateBackfillJob`'s returned `.skipReason` stays
 *       `undefined` and `computeRemainingStatusWithPrisma` observes
 *       `part_visual` pending = 0 → `completed`, never routing the run to the
 *       `skipped_fork_error` retry bucket (which would re-consume
 *       `embeddingBackfillRetryCount` and risk a false `failed` — a
 *       no-fake-success violation).
 *
 * `.skip` / `.todo` / accepted-risk are forbidden (H severity; Severity →
 * Landing Rules require code + CI-failing test).
 *
 * # Test strategy (two surfaces)
 *
 *   (a) AST/source-pin (synchronous, no Docker): the residual path wires the
 *       Layer-1 marker write AND keeps the Layer-2 non-propagation shape
 *       (residual fall-through returns `null`, sets no residual `skipReason`).
 *   (b) Real-DB (testcontainer): seed residual bbox-zero pending parts → run the
 *       production `markResidualBboxUnresolvableParts` → assert per-row markers,
 *       SSOT-predicate exclusion (pending=0), and that
 *       `computeRemainingStatusWithPrisma` reports `completed` (Layer-2 NOT
 *       distorted). An already-embedded part is left untouched (over-termination
 *       guard).
 *
 * @see  §4.3.1 / §9.1 (INV-009)
 * @see ADR-0018 Amendment 10 Decision 10.2 (residual Layer-1 marker, no Layer-2 propagation)
 * @see EMBEDDING_PART_VISUAL_SKIP_REASONS SSOT (src/workers/phases/types.ts)
 *
 * Severity: H (gap B)
 *
 * @module tests/regression/standing/large-page/inv-backfill-part-residual-marker-009
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertInvName } from "../_setup/inv-assert";
import {
  EMBEDDING_PART_VISUAL_SKIP_REASONS,
  partVisualPendingExclusionPredicate,
} from "../../../../src/workers/phases/types";
import { markResidualBboxUnresolvableParts } from "../../../../src/workers/phases/phase-5-embedding";
import {
  collectCategoryPendingSnapshot,
  computeRemainingStatusWithPrisma,
} from "../../../../src/services/backfill-status.helper";

const MCP_SERVER_SRC_ROOT = path.resolve(__dirname, "../../../../src");

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(MCP_SERVER_SRC_ROOT, rel), "utf8");
}

// ============================================================================
// (a) AST / source-pin — Layer-1 marker wired + Layer-2 non-propagation shape
// ============================================================================

describe("INV-BACKFILL-PART-RESIDUAL-MARKER-009: (a) residual path wires Layer-1 marker, no Layer-2 propagation (source-pin)", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-BACKFILL-PART-RESIDUAL-MARKER-009");
  });

  it("INV-BACKFILL-PART-RESIDUAL-MARKER-009: (a) processors residual path calls markResidualBboxUnresolvableParts (Layer-1 DB marker, not audit-only)", () => {
    const processors = readSrc("queues/embedding-backfill-processors.ts");
    // The residual path now writes a DB marker in addition to the existing audit emit.
    expect(processors).toContain("markResidualBboxUnresolvableParts");
    // It is imported from the marker-owning module (reuse, not a forked writer).
    expect(processors).toMatch(
      /import\s*\{[^}]*markResidualBboxUnresolvableParts[^}]*\}\s*from\s*["'][^"']*phase-5-embedding["']/s
    );
    // The existing GDPR Art.30 audit emit is preserved (not replaced by the marker).
    expect(processors).toContain("emitResidualBboxSkipAudit");
  });

  it("INV-BACKFILL-PART-RESIDUAL-MARKER-009: (a) the exported residual-marker helper reuses the idempotent writePartVisualTerminalSkipMarker with the SSOT bbox_unresolvable reason", () => {
    const phase5 = readSrc("workers/phases/phase-5-embedding.ts");
    // The helper is exported for the backfill processors to reuse.
    expect(phase5).toMatch(/export\s+async\s+function\s+markResidualBboxUnresolvableParts\s*\(/);
    // It reuses the existing marker writer (the literal `(ctx,` 4th callsite that
    // INV-PART-VISUAL-SKIP-TERMINAL-001 Block (c) now pins at toBe(4)).
    expect(phase5).toContain(
      'writePartVisualTerminalSkipMarker(ctx, embeddingId, "bbox_unresolvable")'
    );
  });

  it("INV-BACKFILL-PART-RESIDUAL-MARKER-009: (a) Layer-2 non-propagation — residual bbox skip is NOT a returned run-level skipReason (TPA-H-01 / U2)", () => {
    const processors = readSrc("queues/embedding-backfill-processors.ts");
    // The REAL Layer-2 surface (NOT the comment-only `skipReasonToBackfillStatus`)
    // is `BackfillCategoryResult.skipReason` returned by the PartVisualProcessor.
    // The ONLY run-level skipReason value a residual path may RETURN is the
    // SSRF-block case. A returned result carrying `skipReason: "bbox_unresolvable"`
    // would route the run to the `skipped_fork_error` retry bucket (Layer-2
    // propagation) and risk a false `failed`.
    //
    // `skipReason: "bbox_unresolvable"` legitimately appears in the GDPR Art.30
    // AUDIT details (`emitResidualBboxSkipAudit` → `details: { skipReason ... }`)
    // and in the `classifyBboxFailure` type/helper (a `SkipReasonClassification`,
    // NOT a `BackfillCategoryResult`) — those are Layer-1/audit, not a returned
    // run-level result. The REAL Layer-2 surface is a returned
    // `BackfillCategoryResult` (identified by a co-located `category:` field).
    // We pin the absence of a RUN-LEVEL result carrying `bbox_unresolvable`.
    const RUN_LEVEL_RESULT_RETURN =
      /return\s*\{[^}]*\bcategory:[^}]*skipReason:\s*["']([a-z_]+)["']/gs;
    const returnedRunLevelSkipReasons: string[] = [];
    for (const m of processors.matchAll(RUN_LEVEL_RESULT_RETURN)) {
      if (m[1] !== undefined) returnedRunLevelSkipReasons.push(m[1]);
    }
    // The residual bbox skip must NEVER be a returned run-level skipReason
    // (that would route the run to the `skipped_fork_error` retry bucket and risk
    // a false `failed`). The ONLY allowed returned run-level skipReason is the
    // SSRF block.
    expect(
      returnedRunLevelSkipReasons,
      "PartVisualProcessor returned a run-level BackfillCategoryResult.skipReason other " +
        "than 'ssrf_blocked_on_backfill'. Residual bbox skip MUST stay Layer-1 per-row " +
        "marker only — no Layer-2 propagation (TPA-H-01 / U2)."
    ).toEqual(["ssrf_blocked_on_backfill"]);
    // The residual marker is Layer-1 only: the marker call sits inside
    // resolveAndPersistBboxes whose residual path returns `null` (fall-through to
    // the standard visual embedding path), never a BackfillCategoryResult.
    expect(processors).toContain("markResidualBboxUnresolvableParts");
  });
});

// ============================================================================
// (b) Real-DB — Layer-1 terminal-reach + Layer-2 non-distortion (completed)
// ============================================================================

/** SSRF-safe RFC 2606 reserved domain (ADR-0016 § Fixture URL Policy). */
const F009_FIXTURE_URL_PREFIX = "https://example.com/inv-backfill-part-residual-marker-009/";

/**
 * Seeds web_page → section_pattern → component_part (zero-size bounding_box) →
 * component_part_embedding (visual_embedding NULL, visual_skip_reason NULL =
 * pending). The zero-size bbox + pending state models a "residual" part that
 * bbox resolution could NOT fix. Returns the embeddingId (marker / pending key).
 */
async function seedResidualPendingPart(
  prisma: PrismaClient,
  webPageId: string,
  opts?: { bbox?: string; piiRiskLevel?: string }
): Promise<{ embeddingId: string; partId: string }> {
  const bbox = opts?.bbox ?? '{"x":0,"y":0,"width":0,"height":0}';
  const pii = opts?.piiRiskLevel ?? "low";
  const sectionPatternId = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO section_patterns (id, web_page_id, section_type, position_index, layout_info, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'hero', 0, '{}'::jsonb, NOW(), NOW())`,
    sectionPatternId,
    webPageId
  );
  const partId = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO component_parts
       (id, web_page_id, section_pattern_id, part_type, part_subtype,
        computed_styles, attributes, bounding_box, interaction_info,
        pii_risk_level, extracted_at, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'button', 'primary',
        '{}'::jsonb, '{}'::jsonb, $4::jsonb,
        '{}'::jsonb, $5, NOW(), NOW(), NOW())`,
    partId,
    webPageId,
    sectionPatternId,
    bbox,
    pii
  );
  const embeddingId = randomUUID();
  const textVec = `[${new Array<string>(768).fill((1 / Math.sqrt(768)).toFixed(10)).join(",")}]`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO component_part_embeddings
       (id, component_part_id, text_embedding, visual_model_version,
        text_model_version, embedding_timestamp, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::vector, 'mock-dinov2-vit-b14',
        'mock-e5-base-multilingual', NOW(), NOW(), NOW())`,
    embeddingId,
    partId,
    textVec
  );
  return { embeddingId, partId };
}

/** Seeds an already-embedded part (visual_embedding non-NULL = NOT pending). */
async function seedEmbeddedPart(
  prisma: PrismaClient,
  webPageId: string
): Promise<{ embeddingId: string }> {
  const sectionPatternId = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO section_patterns (id, web_page_id, section_type, position_index, layout_info, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'hero', 1, '{}'::jsonb, NOW(), NOW())`,
    sectionPatternId,
    webPageId
  );
  const partId = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO component_parts
       (id, web_page_id, section_pattern_id, part_type, part_subtype,
        computed_styles, attributes, bounding_box, interaction_info,
        pii_risk_level, extracted_at, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'button', 'primary',
        '{}'::jsonb, '{}'::jsonb, '{"x":10,"y":10,"width":80,"height":30}'::jsonb,
        '{}'::jsonb, 'low', NOW(), NOW(), NOW())`,
    partId,
    webPageId,
    sectionPatternId
  );
  const embeddingId = randomUUID();
  const textVec = `[${new Array<string>(768).fill((1 / Math.sqrt(768)).toFixed(10)).join(",")}]`;
  const visualVec = `[${new Array<string>(768).fill((1 / Math.sqrt(768)).toFixed(10)).join(",")}]`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO component_part_embeddings
       (id, component_part_id, text_embedding, visual_embedding, visual_model_version,
        text_model_version, embedding_timestamp, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::vector, $4::vector, 'mock-dinov2-vit-b14',
        'mock-e5-base-multilingual', NOW(), NOW(), NOW())`,
    embeddingId,
    partId,
    textVec,
    visualVec
  );
  return { embeddingId };
}

async function insertWebPage(prisma: PrismaClient, webPageId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO web_pages (id, url, source_type, usage_scope, updated_at)
     VALUES ($1::uuid, $2, 'user_provided', 'inspiration_only', NOW())`,
    webPageId,
    `${F009_FIXTURE_URL_PREFIX}${webPageId}`
  );
}

/** Pending count for a single embeddingId via the production SSOT predicate. */
async function countPending(prisma: PrismaClient, embeddingId: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM component_part_embeddings
     WHERE id = $1::uuid AND ${partVisualPendingExclusionPredicate("component_part_embeddings")}`,
    embeddingId
  );
  return Number(rows[0]?.count ?? 0n);
}

async function readSkipReason(prisma: PrismaClient, embeddingId: string): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ visual_skip_reason: string | null }>>(
    `SELECT visual_skip_reason FROM component_part_embeddings WHERE id = $1::uuid`,
    embeddingId
  );
  return rows[0]?.visual_skip_reason ?? null;
}

describe("INV-BACKFILL-PART-RESIDUAL-MARKER-009: (b) real-DB residual marker terminal-reach + Layer-2 non-distortion", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "[INV-BACKFILL-PART-RESIDUAL-MARKER-009] DATABASE_URL not set by globalSetup (testcontainer boot failure?)"
      );
    }
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    await prisma.$connect();
  }, 60_000);

  afterAll(async () => {
    try {
      await prisma?.$disconnect();
    } catch {
      /* best-effort */
    }
  }, 30_000);

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-BACKFILL-PART-RESIDUAL-MARKER-009");
  });

  it("INV-BACKFILL-PART-RESIDUAL-MARKER-009: (b) residual bbox-zero pending parts → Layer-1 bbox_unresolvable markers → excluded by SSOT predicate (pending = 0)", async () => {
    const webPageId = randomUUID();
    try {
      await insertWebPage(prisma, webPageId);
      const a = await seedResidualPendingPart(prisma, webPageId);
      const b = await seedResidualPendingPart(prisma, webPageId);

      // Pre: both residual parts are pending (gap-B reproduction).
      expect(await countPending(prisma, a.embeddingId)).toBe(1);
      expect(await countPending(prisma, b.embeddingId)).toBe(1);

      // Production Layer-1 residual marker write (H-3).
      const marked = await markResidualBboxUnresolvableParts(prisma, webPageId);
      expect(marked).toBe(2);

      // Post: both excluded by the SSOT predicate → pending = 0 (terminal-reach).
      expect(await countPending(prisma, a.embeddingId)).toBe(0);
      expect(await countPending(prisma, b.embeddingId)).toBe(0);
      expect(await readSkipReason(prisma, a.embeddingId)).toBe("bbox_unresolvable");
      expect(await readSkipReason(prisma, b.embeddingId)).toBe("bbox_unresolvable");
      // The marker is exactly the SSOT-derived terminal reason.
      expect(EMBEDDING_PART_VISUAL_SKIP_REASONS as readonly string[]).toContain(
        "bbox_unresolvable"
      );
    } finally {
      await prisma
        .$executeRawUnsafe(`DELETE FROM web_pages WHERE id = $1::uuid`, webPageId)
        .catch(() => undefined);
    }
  }, 60_000);

  it("INV-BACKFILL-PART-RESIDUAL-MARKER-009: (b) Layer-2 NON-distortion — after residual markers computeRemainingStatusWithPrisma reaches 'completed', part_visual pending 0 (no skipped_fork_error routing)", async () => {
    const webPageId = randomUUID();
    try {
      await insertWebPage(prisma, webPageId);
      // One residual pending part is the ONLY remaining work for this page.
      const a = await seedResidualPendingPart(prisma, webPageId);

      // Pre: part_visual pending = 1 → in_progress (NOT yet terminal).
      const pre = await computeRemainingStatusWithPrisma(webPageId, prisma);
      expect(pre.pendingSnapshot.part_visual).toBe(1);
      expect(pre.finalStatus).toBe("in_progress");

      // Production Layer-1 residual marker (H-3) — terminal-reach via marker, NOT
      // via a run-level skip channel.
      await markResidualBboxUnresolvableParts(prisma, webPageId);

      // Post: part_visual pending = 0 → completed. The REAL run-level surface
      // (computeRemainingStatusWithPrisma) observes terminal-reach directly; the
      // residual marker did NOT route the run to skipped_fork_error retry bucket.
      const post = await computeRemainingStatusWithPrisma(webPageId, prisma);
      expect(post.pendingSnapshot.part_visual).toBe(0);
      expect(post.finalStatus).toBe("completed");

      // Cross-check the snapshot helper sees the same terminal-reach.
      const snap = await collectCategoryPendingSnapshot(webPageId, prisma);
      expect(snap.part_visual).toBe(0);
    } finally {
      await prisma
        .$executeRawUnsafe(`DELETE FROM web_pages WHERE id = $1::uuid`, webPageId)
        .catch(() => undefined);
    }
  }, 60_000);

  it("INV-BACKFILL-PART-RESIDUAL-MARKER-009: (b) idempotent + over-termination guard — already-embedded parts are NOT marked, re-run is a no-op", async () => {
    const webPageId = randomUUID();
    try {
      await insertWebPage(prisma, webPageId);
      const residual = await seedResidualPendingPart(prisma, webPageId);
      const embedded = await seedEmbeddedPart(prisma, webPageId);

      // First pass marks only the residual pending part (1), not the embedded one.
      const firstPass = await markResidualBboxUnresolvableParts(prisma, webPageId);
      expect(firstPass).toBe(1);
      expect(await readSkipReason(prisma, residual.embeddingId)).toBe("bbox_unresolvable");
      // Over-termination guard: the already-embedded part is untouched.
      expect(await readSkipReason(prisma, embedded.embeddingId)).toBeNull();

      // Idempotent re-run: no residual pending rows remain → marks 0.
      const secondPass = await markResidualBboxUnresolvableParts(prisma, webPageId);
      expect(secondPass).toBe(0);
      // The marker did not change on re-run (idempotent WHERE visual_skip_reason IS NULL guard).
      expect(await readSkipReason(prisma, residual.embeddingId)).toBe("bbox_unresolvable");
    } finally {
      await prisma
        .$executeRawUnsafe(`DELETE FROM web_pages WHERE id = $1::uuid`, webPageId)
        .catch(() => undefined);
    }
  }, 60_000);

  it("INV-BACKFILL-PART-RESIDUAL-MARKER-009: (b) PII guard — pii_risk_level='high' residual parts are NOT marked (excluded like the main-path loop)", async () => {
    const webPageId = randomUUID();
    try {
      await insertWebPage(prisma, webPageId);
      const highPii = await seedResidualPendingPart(prisma, webPageId, {
        piiRiskLevel: "high",
      });
      const lowPii = await seedResidualPendingPart(prisma, webPageId, {
        piiRiskLevel: "low",
      });

      const marked = await markResidualBboxUnresolvableParts(prisma, webPageId);
      // Only the low-PII residual part is marked; high-PII part is skipped
      // (mirrors processPartVisualEmbeddingLoop's `piiRiskLevel: { not: "high" }`).
      expect(marked).toBe(1);
      expect(await readSkipReason(prisma, lowPii.embeddingId)).toBe("bbox_unresolvable");
      expect(await readSkipReason(prisma, highPii.embeddingId)).toBeNull();
    } finally {
      await prisma
        .$executeRawUnsafe(`DELETE FROM web_pages WHERE id = $1::uuid`, webPageId)
        .catch(() => undefined);
    }
  }, 60_000);
});
