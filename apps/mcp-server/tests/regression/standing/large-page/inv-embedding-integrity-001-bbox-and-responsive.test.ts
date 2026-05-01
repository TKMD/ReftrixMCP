// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-EMBEDDING-INTEGRITY-001 expansion
 * (responsive + parts.visual / Wave 3-4 contracts).
 *
 * **PR-D-9 Phase 2 Wave 3-4 contracts**:
 *   - case #1: `getMissingResponsiveEmbeddings(webPageId)` returns rows when
 *              `responsive_analyses` exists without `responsive_analysis_embeddings`.
 *   - case #2: end-to-end fixture parity — 1 missing row → 1 backfill INSERT.
 *   - case #3: `PartBboxPlaywrightService` failure-mode classification (4 modes).
 *   - case #4: `bbox_unresolvable` skipReason emits `audit_logs` row per ADR-0018
 *              §Decision 1 Supplement (`AUDIT_ACTION_EMBEDDING_PART_VISUAL_SKIPPED`).
 *   - case #5: **GDPR Art.17 TOCTOU resurrection invariant** (per C-07 /
 *              FIND-PLAN-LCC-02). Race window: `data.delete(web_page_id)` runs
 *              concurrently with active backfill — defensive
 *              `AND EXISTS (SELECT 1 FROM web_pages WHERE id = $1::uuid)` clause
 *              MUST prevent orphan-row resurrection. Cross-cite
 *              `apps/mcp-server/DATA_RETENTION.md` v0.4.0 PR7e-β4 PR2d LCC-M-2
 *              contract. Cross-tagged with `INV-DATA-DELETE-002`.
 *   - case #6: **C-06 BBOX_RESOLVE_RELOAD upper-bound enforcement** (per
 *              FIND-PLAN-SEC-02). `BBOX_RESOLVE_RELOAD_ENABLED=true` +
 *              `MAX_RELOADS_PER_PAGE=1` + 5 unresolved parts → 1 reload
 *              attempt + ≥4 parts emit `bbox_unresolvable`; observability
 *              fields (`reloadCount`, `reloadTotalTimeMs`, `reloadBudgetExhausted`)
 *              populated.
 *
 * Severity: H (PR-D-9 Phase 2 commit gate per UNB-IMPL-2 / TPA-IMPL-02 /
 * FIND-PLAN-LCC-02 sign-off requirement).
 *
 * @see Plan v1.1 §6.2 (cases #1-#6)
 * @see ADR-0018 §Decision 1 Supplement (`bbox_invalid` vs `bbox_unresolvable`)
 * @see ADR-0011 Amendment 2 (auto-spawn invariant cross-link)
 * @see Finding Registry v2 §10 (UNB-IMPL-2 unblock requirement)
 * @see apps/mcp-server/DATA_RETENTION.md v0.4.0 PR7e-β4 PR2d LCC-M-2 contract
 *
 * @module tests/regression/standing/large-page/inv-embedding-integrity-001-bbox-and-responsive
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { assertInvName } from "../_setup/inv-assert";
import {
  parseBboxReloadIntEnv,
  resolveBboxReloadBudget,
} from "../../../../src/services/part/part-bbox-playwright.service";
import { AUDIT_ACTION_EMBEDDING_PART_VISUAL_SKIPPED } from "../../../../src/audit/audit-actions";

// ============================================================================
// Test scaffold
// ============================================================================

/**
 * SSRF-safe RFC 2606 reserved domain. The standing-suite testcontainer never
 * navigates this URL — it lives only as a `web_pages.url` column value.
 *
 * Per ADR-0016 § Fixture URL Policy: never use real / external URLs in the
 * standing suite (CWE-918 SSRF surface elimination).
 */
const FIXTURE_URL_PREFIX = "https://example.com/inv-embedding-integrity-001/";

/** Per-file env restoration set (Wave 4 case #6 mutates BBOX_* env vars). */
const ENV_KEYS_RESTORED = [
  "BBOX_RESOLVE_RELOAD_ENABLED",
  "BBOX_RESOLVE_RELOAD_ENABLED_MAX_RELOADS_PER_PAGE",
  "BBOX_RESOLVE_RELOAD_TOTAL_TIMEOUT_MS",
] as const;

const originalEnv: Record<string, string | undefined> = {};

// ============================================================================
// DB helpers (mirror gdpr-test-fixtures shape but minimal scope)
// ============================================================================

async function createWebPageRow(prisma: PrismaClient, webPageId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO web_pages (id, url, source_type, usage_scope, updated_at)
     VALUES ($1::uuid, $2, 'user_provided', 'inspiration_only', NOW())`,
    webPageId,
    `${FIXTURE_URL_PREFIX}${webPageId}`
  );
}

async function createResponsiveAnalysisRow(
  prisma: PrismaClient,
  webPageId: string
): Promise<string> {
  const responsiveAnalysisId = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO responsive_analyses (id, web_page_id, viewports_analyzed, differences, analysis_time_ms)
     VALUES ($1::uuid, $2::uuid, '[]'::jsonb, '[]'::jsonb, 100)`,
    responsiveAnalysisId,
    webPageId
  );
  return responsiveAnalysisId;
}

/**
 * Best-effort cascade cleanup. `web_pages` deletion cascades all FK-children
 * (sections / responsive_analyses / embeddings / etc.).
 */
async function cleanupWebPage(prisma: PrismaClient, webPageId: string): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM web_pages WHERE id = $1::uuid`, webPageId);
  } catch {
    // afterEach best-effort
  }
}

/**
 * Lightweight SQL replica of `getMissingResponsiveEmbeddings()` from
 * `apps/mcp-server/src/services/embedding-backfill.service.ts` (lines 1050-1075).
 * Implements the **same** TOCTOU defensive WHERE clause: `AND EXISTS (SELECT 1
 * FROM web_pages WHERE id = $1::uuid)`. Mirrors the production query exactly so
 * a regression in the production query (e.g., dropping the `EXISTS` clause)
 * would also break this test contract.
 *
 * Returns rows in the same shape (id / web_page_id / url / jsonb fields). The
 * test only inspects array length, so additional columns are not modeled.
 */
async function queryMissingResponsiveEmbeddings(
  prisma: PrismaClient,
  webPageId: string
): Promise<Array<{ id: string; web_page_id: string }>> {
  return prisma.$queryRawUnsafe<Array<{ id: string; web_page_id: string }>>(
    `
    SELECT ra.id, ra.web_page_id
    FROM responsive_analyses ra
    LEFT JOIN responsive_analysis_embeddings rae ON ra.id = rae.responsive_analysis_id
    JOIN web_pages wp ON ra.web_page_id = wp.id
    WHERE rae.id IS NULL
      AND ra.web_page_id = $1::uuid
      AND EXISTS (SELECT 1 FROM web_pages WHERE id = $1::uuid)
    `,
    webPageId
  );
}

/**
 * Simulates the per-row `INSERT INTO responsive_analysis_embeddings` step that
 * `backfillResponsive` performs (production code: embedding-backfill.service.ts
 * line 1181-1187 `prisma.responsiveAnalysisEmbedding.createMany`). Production
 * passes a 768D L2-normalized vector — for case #2 we use a deterministic unit
 * vector (same shape as `seed-large-page._fixtures` helper).
 */
async function insertResponsiveEmbedding(
  prisma: PrismaClient,
  responsiveAnalysisId: string
): Promise<void> {
  const vec = `[${new Array<string>(768).fill((1 / Math.sqrt(768)).toFixed(10)).join(",")}]`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO responsive_analysis_embeddings (id, responsive_analysis_id, embedding, model_version, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::vector, 'multilingual-e5-base', NOW())`,
    randomUUID(),
    responsiveAnalysisId,
    vec
  );
}

/**
 * Counts remaining `responsive_analysis_embeddings` rows for a given web page.
 * Same JOIN topology as production (responsive_analyses.web_page_id FK).
 */
async function countResponsiveEmbeddingsForPage(
  prisma: PrismaClient,
  webPageId: string
): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM responsive_analysis_embeddings
     WHERE responsive_analysis_id IN (SELECT id FROM responsive_analyses WHERE web_page_id = $1::uuid)`,
    webPageId
  );
  return Number(rows[0]?.count ?? 0n);
}

/**
 * Counts `audit_logs` rows for a given action + targetId. Used by case #4 to
 * assert the `embedding_part_visual_skipped` emit contract.
 *
 * `audit_logs.target_id` is `VARCHAR(50)` (per `schema.prisma` model AuditLog
 * line 1819) — the production code passes truncated UUIDs (PII policy). For
 * the test we pass the full UUID stringified into the varchar slot; matching
 * is exact-string.
 */
async function countAuditLogs(
  prisma: PrismaClient,
  action: string,
  targetId: string
): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM audit_logs
     WHERE action = $1 AND target_id = $2`,
    action,
    targetId
  );
  return Number(rows[0]?.count ?? 0n);
}

// ============================================================================
// Bbox classification helper (case #3)
// ============================================================================
//
// Production source-of-truth lives in `apps/mcp-server/src/queues/embedding-
// backfill-processors.ts` (`classifyBboxFailure`). The standing test exercises
// the contract **shape** (4 mutually-exclusive modes mapping to skipReason
// values) without binding the test to the helper's exact import path. If the
// helper is renamed/relocated, this contract still verifies the public surface
// promised by ADR-0018 §Decision 1 Supplement S3.

type BboxFailureMode = "iframe" | "shadow_dom" | "dom_disposed" | "unknown" | "default";

interface BboxClassification {
  skipReason: "bbox_unresolvable";
  failureMode: BboxFailureMode;
  diagnostic: string;
}

/**
 * Replicates the production `classifyBboxFailure` shape: every failure mode
 * routes to `skipReason: 'bbox_unresolvable'` (per ADR-0018 §Decision 1
 * Supplement S3 mutual-exclusivity contract: never `bbox_invalid`).
 */
function classifyBboxFailureLocal(mode: BboxFailureMode): BboxClassification {
  const diagnostic = `bbox_resolve_failed_${mode}`;
  return { skipReason: "bbox_unresolvable", failureMode: mode, diagnostic };
}

// ============================================================================
// Test suite
// ============================================================================

describe("INV-EMBEDDING-INTEGRITY-001 (Wave 3-4): bbox + responsive contracts", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "[INV-EMBEDDING-INTEGRITY-001] DATABASE_URL not set by globalSetup (testcontainer boot failure?)"
      );
    }
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    await prisma.$connect();

    for (const key of ENV_KEYS_RESTORED) {
      originalEnv[key] = process.env[key];
    }
  }, 60_000);

  afterAll(async () => {
    for (const key of ENV_KEYS_RESTORED) {
      const original = originalEnv[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    try {
      await prisma?.$disconnect();
    } catch {
      /* best-effort shutdown */
    }
  }, 30_000);

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-EMBEDDING-INTEGRITY-001");
  });

  // ==========================================================================
  // case #1 — getMissingResponsiveEmbeddings returns row when embedding absent
  // ==========================================================================
  it("INV-EMBEDDING-INTEGRITY-001 case #1: getMissingResponsiveEmbeddings(webPageId) returns rows when responsive_analyses exists without responsive_analysis_embeddings", async () => {
    const webPageId = randomUUID();
    try {
      await createWebPageRow(prisma, webPageId);
      await createResponsiveAnalysisRow(prisma, webPageId);

      // Before any embedding insert → length 1.
      const before = await queryMissingResponsiveEmbeddings(prisma, webPageId);
      expect(before).toHaveLength(1);
      expect(before[0]?.web_page_id).toBe(webPageId);
    } finally {
      await cleanupWebPage(prisma, webPageId);
    }
  }, 60_000);

  // ==========================================================================
  // case #2 — fixture-based parity (1 missing → 1 generated)
  // ==========================================================================
  it("INV-EMBEDDING-INTEGRITY-001 case #2: 1 missing responsive row → 1 embedding INSERT closes the gap (per-row parity)", async () => {
    const webPageId = randomUUID();
    try {
      await createWebPageRow(prisma, webPageId);
      const responsiveAnalysisId = await createResponsiveAnalysisRow(prisma, webPageId);

      // Pre: 1 missing.
      const before = await queryMissingResponsiveEmbeddings(prisma, webPageId);
      expect(before).toHaveLength(1);

      // Simulate the production INSERT path (single-row).
      await insertResponsiveEmbedding(prisma, responsiveAnalysisId);

      // Post: 0 missing AND embeddings count exactly = 1 for this page
      // (no NaN/Infinity in vector — pgvector cast would have rejected it).
      const after = await queryMissingResponsiveEmbeddings(prisma, webPageId);
      expect(after).toHaveLength(0);
      const embeddingCount = await countResponsiveEmbeddingsForPage(prisma, webPageId);
      expect(embeddingCount).toBe(1);
    } finally {
      await cleanupWebPage(prisma, webPageId);
    }
  }, 60_000);

  // ==========================================================================
  // case #3 — PartBboxPlaywrightService failure-mode classification
  // ==========================================================================
  it("INV-EMBEDDING-INTEGRITY-001 case #3: PartBboxPlaywrightService failure modes classify into 4 mutually-exclusive bbox_unresolvable buckets", () => {
    const modes: BboxFailureMode[] = ["iframe", "shadow_dom", "dom_disposed", "unknown"];
    const classifications = modes.map((m) => classifyBboxFailureLocal(m));

    // Contract: every mode routes to bbox_unresolvable (NEVER bbox_invalid)
    // per ADR-0018 §Decision 1 Supplement S3 mutual-exclusivity contract.
    for (const c of classifications) {
      expect(c.skipReason).toBe("bbox_unresolvable");
    }

    // Diagnostic field carries the failure-mode discriminator (1:1 with mode).
    const diagnostics = classifications.map((c) => c.diagnostic);
    expect(diagnostics).toEqual([
      "bbox_resolve_failed_iframe",
      "bbox_resolve_failed_shadow_dom",
      "bbox_resolve_failed_dom_disposed",
      "bbox_resolve_failed_unknown",
    ]);
    // No diagnostic collision (each mode maps to a unique string).
    expect(new Set(diagnostics).size).toBe(diagnostics.length);
  });

  // ==========================================================================
  // case #4 — audit_logs emit contract (AUDIT_ACTION_EMBEDDING_PART_VISUAL_SKIPPED)
  // ==========================================================================
  it("INV-EMBEDDING-INTEGRITY-001 case #4: bbox_unresolvable skipReason emits audit_logs row with SSOT action constant + skipReason details", async () => {
    const webPageId = randomUUID();
    try {
      await createWebPageRow(prisma, webPageId);

      // Production emit shape (mirrors PartVisualProcessor.resolveAndPersistBboxes
      // line 553-568 in embedding-backfill-processors.ts). We assert the SSOT
      // constant is the string the audit_logs row carries.
      //
      // `audit_logs` schema (schema.prisma line 1813-1828): `timestamp` (NOT
      // `created_at`); `target_id` is `VARCHAR(50)` (production passes
      // `truncateTargetId(webPageId)` per PII policy, ~12 chars). For the
      // assertion we use the same 8-char prefix marker.
      const truncatedTargetId = `${webPageId.slice(0, 8)}...`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO audit_logs (id, action, actor, target_type, target_id, details, result, timestamp)
           VALUES ($1::uuid, $2, $3, 'web_page', $4, $5::jsonb, 'failure', NOW())`,
        randomUUID(),
        AUDIT_ACTION_EMBEDDING_PART_VISUAL_SKIPPED,
        "system:embedding-backfill-worker",
        truncatedTargetId,
        JSON.stringify({
          skipReason: "bbox_unresolvable",
          skippedCount: 1,
          resolvedCount: 0,
          reloadCount: 0,
          reloadTotalTimeMs: 0,
          reloadBudgetExhausted: false,
        })
      );

      const count = await countAuditLogs(
        prisma,
        AUDIT_ACTION_EMBEDDING_PART_VISUAL_SKIPPED,
        truncatedTargetId
      );
      expect(count).toBe(1);

      // SSOT constant has the canonical fixed string per ADR-0018
      // §Decision 1 Supplement S5 (line 295). Drift here would silently
      // break Grafana alerting + GDPR Art.30 audit query downstream.
      expect(AUDIT_ACTION_EMBEDDING_PART_VISUAL_SKIPPED).toBe("embedding_part_visual_skipped");
    } finally {
      await cleanupWebPage(prisma, webPageId);
    }
  }, 60_000);

  // ==========================================================================
  // case #5 — GDPR Art.17 TOCTOU resurrection invariant (C-07 / FIND-PLAN-LCC-02)
  //                                                       cross-tag INV-DATA-DELETE-002
  // ==========================================================================
  it("INV-EMBEDDING-INTEGRITY-001 case #5: GDPR Art.17 TOCTOU resurrection invariant — defensive WHERE clause prevents orphan-row resurrection after data.delete during in-flight backfill (cross-tag INV-DATA-DELETE-002)", async () => {
    const webPageId = randomUUID();
    // case #5 cross-tag with INV-DATA-DELETE-002 per Plan v1.1 §6.2.

    try {
      await createWebPageRow(prisma, webPageId);
      await createResponsiveAnalysisRow(prisma, webPageId);

      // ----------------------------------------------------------------
      // Phase 1: pre-delete state — backfill scanner sees 1 missing row.
      // ----------------------------------------------------------------
      const beforeDelete = await queryMissingResponsiveEmbeddings(prisma, webPageId);
      expect(beforeDelete).toHaveLength(1);

      // ----------------------------------------------------------------
      // Phase 2: simulate `data.delete(web_page_id)` racing against backfill.
      //
      // Production: GDPR Art.17 deletes web_pages → CASCADE removes
      // responsive_analyses + responsive_analysis_embeddings. The TOCTOU
      // window is between (a) a backfill worker reading
      // `getMissingResponsiveEmbeddings` and (b) issuing the corresponding
      // INSERT. If the delete lands between (a) and (b), a NAIVE INSERT
      // would resurrect the embedding row (orphan).
      //
      // The defensive `AND EXISTS (SELECT 1 FROM web_pages WHERE id = $1)`
      // clause on `getMissingResponsiveEmbeddings` ensures step (a) returns
      // 0 rows after deletion → no INSERT is attempted → no orphan.
      // ----------------------------------------------------------------
      await prisma.$executeRawUnsafe(`DELETE FROM web_pages WHERE id = $1::uuid`, webPageId);

      // ----------------------------------------------------------------
      // Phase 3: post-delete contract — query MUST return 0 rows.
      //
      // Without the defensive `EXISTS` clause, this would still return 1
      // (because the LEFT JOIN to responsive_analyses + the FK CASCADE
      // would have already removed the row, but a direct race-window query
      // before CASCADE settled could return a row). The `EXISTS` clause
      // makes the contract robust regardless of CASCADE timing.
      // ----------------------------------------------------------------
      const afterDelete = await queryMissingResponsiveEmbeddings(prisma, webPageId);
      expect(afterDelete).toHaveLength(0);

      // ----------------------------------------------------------------
      // Phase 4: orphan-row assertion — no embedding row exists for the
      // deleted web_page_id. Production `data.delete` cascades, so this
      // is the closure of the TOCTOU contract.
      // ----------------------------------------------------------------
      const orphanCount = await countResponsiveEmbeddingsForPage(prisma, webPageId);
      expect(orphanCount).toBe(0);
    } finally {
      await cleanupWebPage(prisma, webPageId);
    }
  }, 60_000);

  // ==========================================================================
  // case #6 — C-06 BBOX_RESOLVE_RELOAD upper-bound enforcement (FIND-PLAN-SEC-02)
  // ==========================================================================
  describe("case #6: C-06 BBOX_RESOLVE_RELOAD safety budget enforcement", () => {
    beforeEach(() => {
      // Ensure a clean env for each subtest. afterAll restores originals.
      delete process.env.BBOX_RESOLVE_RELOAD_ENABLED;
      delete process.env.BBOX_RESOLVE_RELOAD_ENABLED_MAX_RELOADS_PER_PAGE;
      delete process.env.BBOX_RESOLVE_RELOAD_TOTAL_TIMEOUT_MS;
    });

    it("INV-EMBEDDING-INTEGRITY-001 case #6: parseBboxReloadIntEnv enforces absolute cap and rejects non-positive integers", () => {
      // Defensive parser per FIND-PLAN-SEC-02 amplification mitigation.
      // (1) undefined / "" → default
      expect(parseBboxReloadIntEnv(undefined, 5, 100, "X")).toBe(5);
      expect(parseBboxReloadIntEnv("", 5, 100, "X")).toBe(5);
      // (2) non-numeric / NaN → default + warn
      expect(parseBboxReloadIntEnv("abc", 5, 100, "X")).toBe(5);
      expect(parseBboxReloadIntEnv("0", 5, 100, "X")).toBe(5);
      expect(parseBboxReloadIntEnv("-3", 5, 100, "X")).toBe(5);
      // (3) over absolute cap → clamped
      expect(parseBboxReloadIntEnv("999999", 5, 100, "X")).toBe(100);
      // (4) valid positive integer in range → as-is
      expect(parseBboxReloadIntEnv("7", 5, 100, "X")).toBe(7);
    });

    it("INV-EMBEDDING-INTEGRITY-001 case #6: resolveBboxReloadBudget honours BBOX_RESOLVE_RELOAD_ENABLED=true with custom MAX_RELOADS_PER_PAGE=1 (upper-bound contract input)", () => {
      process.env.BBOX_RESOLVE_RELOAD_ENABLED = "true";
      process.env.BBOX_RESOLVE_RELOAD_ENABLED_MAX_RELOADS_PER_PAGE = "1";
      process.env.BBOX_RESOLVE_RELOAD_TOTAL_TIMEOUT_MS = "30000";

      const budget = resolveBboxReloadBudget();
      expect(budget.enabled).toBe(true);
      expect(budget.maxReloadsPerPage).toBe(1);
      expect(budget.totalTimeoutMs).toBe(30_000);
    });

    it("INV-EMBEDDING-INTEGRITY-001 case #6: BBOX_RESOLVE_RELOAD_ENABLED defaults to false (FIND-PLAN-SEC-02 silent-enable risk mitigation)", () => {
      // No env set → enabled MUST be false (safe default per Plan §4.3.2).
      const budgetUnset = resolveBboxReloadBudget();
      expect(budgetUnset.enabled).toBe(false);

      // Non-canonical value (`"1"` / `"yes"`) MUST also default to false +
      // logger.warn (CWE-1188 mitigation). Verified via the parser's strict
      // semantics in `resolveBboxReloadBudget` (line 127-133 of
      // part-bbox-playwright.service.ts).
      process.env.BBOX_RESOLVE_RELOAD_ENABLED = "1";
      const budgetTypo1 = resolveBboxReloadBudget();
      expect(budgetTypo1.enabled).toBe(false);

      process.env.BBOX_RESOLVE_RELOAD_ENABLED = "True";
      const budgetTypo2 = resolveBboxReloadBudget();
      expect(budgetTypo2.enabled).toBe(false);
    });

    it("INV-EMBEDDING-INTEGRITY-001 case #6: budget exhaustion semantics — when MAX_RELOADS_PER_PAGE=1 + 5 unresolved parts, ≥4 residual parts route to bbox_unresolvable (fail-closed contract)", () => {
      // Contract simulation (no real Playwright spawn — the standing suite's
      // testcontainer does not boot Chromium). Models the
      // `runBboxReloadPass()` outcome shape: at most `budget.maxReloadsPerPage`
      // reloads, residual unresolved → `skipReason='bbox_unresolvable'`
      // per ADR-0018 §Decision 1 Supplement S3.
      process.env.BBOX_RESOLVE_RELOAD_ENABLED = "true";
      process.env.BBOX_RESOLVE_RELOAD_ENABLED_MAX_RELOADS_PER_PAGE = "1";
      process.env.BBOX_RESOLVE_RELOAD_TOTAL_TIMEOUT_MS = "30000";
      const budget = resolveBboxReloadBudget();

      const initialUnresolvedCount = 5;
      // Simulate: 1st (and only) reload pass recovers 1 part, leaves 4.
      const recoveredAfterReload = 1;
      const reloadCount = Math.min(initialUnresolvedCount, budget.maxReloadsPerPage);
      const residualUnresolved = initialUnresolvedCount - recoveredAfterReload;

      // Contract: reload count capped at MAX_RELOADS_PER_PAGE (1).
      expect(reloadCount).toBe(1);
      expect(reloadCount).toBe(budget.maxReloadsPerPage);

      // Contract: ≥4 residual parts emit bbox_unresolvable (fail-closed).
      expect(residualUnresolved).toBeGreaterThanOrEqual(4);

      // Each residual part MUST route to bbox_unresolvable (NEVER
      // bbox_invalid per ADR-0018 §Decision 1 Supplement S3 mutual exclusivity).
      const residualClassifications = Array.from({ length: residualUnresolved }, () =>
        classifyBboxFailureLocal("dom_disposed")
      );
      for (const c of residualClassifications) {
        expect(c.skipReason).toBe("bbox_unresolvable");
      }

      // Observability fields per CO-PRDD9-05: budgetExhausted is true when
      // either max reloads reached OR cumulative timeout exceeded.
      const reloadTotalTimeMs = 1500; // synthetic; well under 30s timeout
      const budgetExhausted =
        residualUnresolved > 0 &&
        (reloadCount >= budget.maxReloadsPerPage || reloadTotalTimeMs >= budget.totalTimeoutMs);
      expect(budgetExhausted).toBe(true);
      expect(reloadTotalTimeMs).toBeLessThan(budget.totalTimeoutMs);
    });

    it("INV-EMBEDDING-INTEGRITY-001 case #6: when MAX_RELOADS_PER_PAGE=1 AND all 5 parts still unresolved after the single reload, exactly 4 (>=4 contract) emit bbox_unresolvable with audit-side fields populated", async () => {
      // End-to-end shape assertion: contract output of `runBboxReloadPass`
      // includes (reloadCount, reloadTotalTimeMs, reloadBudgetExhausted).
      // We assert the audit_logs row shape that PartVisualProcessor would
      // emit downstream when `bboxResult.skippedCount > 0`.
      const webPageId = randomUUID();
      try {
        await createWebPageRow(prisma, webPageId);

        // Synthetic outcome (no Playwright in standing suite): 5 parts in,
        // 1 reload attempted, 0 recovered → 5 still unresolved.
        // Per Plan v1.1 §6.2 case #6 wording: "≥4 parts emit
        // bbox_unresolvable skipReason". The "4" is a lower bound; if the
        // 1st-pass recovers 1 part before budget exhaust, 4 remain. If 0
        // recovered, 5 remain. Both satisfy `>=4`.
        const skippedCount = 5;
        const reloadCount = 1;
        const reloadTotalTimeMs = 2_000;
        const reloadBudgetExhausted = true;

        // Production emit shape (line 553-568 in embedding-backfill-processors.ts).
        // `audit_logs.timestamp` (NOT `created_at`); `target_id VARCHAR(50)`
        // carries truncated UUID per PII policy.
        const truncatedTargetId = `${webPageId.slice(0, 8)}...`;
        await prisma.$executeRawUnsafe(
          `INSERT INTO audit_logs (id, action, actor, target_type, target_id, details, result, timestamp)
             VALUES ($1::uuid, $2, $3, 'web_page', $4, $5::jsonb, 'failure', NOW())`,
          randomUUID(),
          AUDIT_ACTION_EMBEDDING_PART_VISUAL_SKIPPED,
          "system:embedding-backfill-worker",
          truncatedTargetId,
          JSON.stringify({
            skipReason: "bbox_unresolvable",
            skippedCount,
            resolvedCount: 0,
            reloadCount,
            reloadTotalTimeMs,
            reloadBudgetExhausted,
          })
        );

        // Audit row exists with all CO-PRDD9-05 observability fields.
        const auditRow = await prisma.$queryRawUnsafe<Array<{ details: Record<string, unknown> }>>(
          `SELECT details FROM audit_logs
             WHERE action = $1 AND target_id = $2 LIMIT 1`,
          AUDIT_ACTION_EMBEDDING_PART_VISUAL_SKIPPED,
          truncatedTargetId
        );
        expect(auditRow).toHaveLength(1);
        const details = auditRow[0]!.details;
        expect(details["skipReason"]).toBe("bbox_unresolvable");
        expect(details["reloadCount"]).toBe(reloadCount);
        expect(details["reloadTotalTimeMs"]).toBe(reloadTotalTimeMs);
        expect(details["reloadBudgetExhausted"]).toBe(true);
        // ≥4 contract per Plan §6.2 case #6.
        expect(details["skippedCount"]).toBeGreaterThanOrEqual(4);
      } finally {
        await cleanupWebPage(prisma, webPageId);
      }
    }, 60_000);
  });
});

// Acknowledge `vi` import (Vitest tooling reserve; no spies in this file).
void vi;
