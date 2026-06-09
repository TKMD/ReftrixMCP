// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — large-page domain
 *
 * INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011 (PR-C4 V1.1 §3 Path A + Path B /
 * §4 / IO Plan Decision V1 Registry INV-011 row + SEC-RV1-03 / U1):
 *
 *   Root cause (PII asymmetry): an in-range high-PII section
 *   (`component_parts.pii_risk_level = 'high'` within the section's
 *   section_pattern) is intentionally excluded by the WORK side for GDPR Art.5(1)(c)
 *   data-minimisation (the work-side `highPiiSectionIdSet` filter — the section
 *   reaches neither DINOv2 nor `writeSectionVisionSkipReason`). But the PENDING
 *   side `sectionVisualPendingExclusionPredicate` lacked the symmetric PII filter,
 *   so the high-PII section counted as pending=1 forever → page never reaches
 *   `completed` (infinite `in_progress`). The part_visual / part_text pending
 *   queries ARE symmetric (`pii_risk_level != 'high'`); section_visual was the
 *   only asymmetric one.
 *
 *   Contract (two orthogonal defense layers + terminal-status mapping):
 *     - **Path A (query-level)**: `sectionVisualPendingExclusionPredicate` now
 *       carries a PII filter (`NOT EXISTS (... component_parts cp ...
 *       pii_risk_level = 'high')`) symmetric with the work-side exclusion, and all
 *       3 canonical callsites reference the SSOT predicate (no inline WHERE). A
 *       high-PII section is therefore excluded from pending → pending = 0.
 *     - **Path B (row-level marker)**: the work-side PII-exclusion site writes
 *       `vision_skip_reason = 'section_visual_pii_excluded'` (GDPR Art.30
 *       processing trail: "intentionally not visually embedded due to PII"). A
 *       non-NULL `vision_skip_reason` ALSO excludes the row from pending (the
 *       second, robustness-providing defense layer), and the marker audit emit
 *       routes the targetId through the `truncateAuditTargetId` SSOT (CWE-209 PII
 *       minimisation, SEC-RV1-03 / U1).
 *     - **Terminal → completed**: `skipReasonToBackfillStatus('section_visual_pii_excluded')`
 *       maps to `not_required` (terminal-skip = page completable; MUST NOT map to
 *       `skipped_fork_error` retry bucket). With section_visual pending = 0,
 *       `verifyCategoryParity` ⇒ completed-eligible.
 *     - **Orthogonality (real-leak)**: a section that is NOT high-PII but has
 *       `vision_embedding IS NULL` AND `vision_skip_reason IS NULL` remains pending
 *       (real-leak / retry target) — the predicate still encodes
 *       `vision_skip_reason IS NULL` (INV-(b) orthogonality per ADR-0018 §7.5).
 *
 * # Test strategy (mirrors INV-PART-VISUAL-SKIP-TERMINAL-001's canonical pattern)
 *
 *   Three deterministic surfaces (no testcontainer / Redis):
 *     1. SSOT predicate fragment assertions (Path A PII NOT EXISTS + Path B
 *        `vision_skip_reason IS NULL` orthogonality conjuncts).
 *     2. AST/source-pin: 3 canonical callsites reference the SSOT predicate; the
 *        work-side filter site writes the `section_visual_pii_excluded` marker;
 *        marker audit emit uses `truncateAuditTargetId`.
 *     3. Algorithmic: `skipReasonToBackfillStatus` ⇒ `not_required`; SSOT-derived
 *        terminal subset membership; `verifyCategoryParity` green (pending=0
 *        completed) + red (section_visual residual NOT completed).
 *
 * CI-failing executable invariant. `.skip()` / `.todo()` / `describe.skip` are
 * FORBIDDEN (INV-011 is H severity). Failure is a P0 incident handled by
 * pipeline-engineer + capture-embedding-engineer.
 *
 * @see  §3 Path A/B / §4
 * @see  (INV-011, SEC-RV1-03, U1)
 * @see apps/mcp-server/src/workers/phases/types.ts (sectionVisualPendingExclusionPredicate, EMBEDDING_SECTION_VISUAL_SKIP_REASONS)
 * @see apps/mcp-server/src/workers/phases/phase-5-embedding.ts (work-side PII-exclusion marker write)
 * @see apps/mcp-server/src/services/audit-log.service.ts (truncateAuditTargetId SSOT)
 * @see apps/mcp-server/tests/regression/standing/large-page/inv-part-visual-skip-terminal-001.test.ts (sibling canonical pattern)
 *
 * @module tests/regression/standing/large-page/inv-section-visual-pii-excluded-terminal-011
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, it, expect, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { assertInvName } from "../_setup/inv-assert";
import { createAstProject, addMcpServerSourceFile } from "../schema-enum-sync/_extractors";
import {
  EMBEDDING_SECTION_VISUAL_SKIP_REASONS,
  EMBEDDING_SKIP_REASONS,
  sectionVisualPendingExclusionPredicate,
} from "../../../../src/workers/phases/types";
import { verifyCategoryParity } from "../../../../src/services/backfill-status.helper";
import {
  EMBEDDING_BACKFILL_CATEGORIES,
  type EmbeddingBackfillCategory,
} from "../../../../src/queues/embedding-backfill-queue";
import { emitSectionVisualPiiExcludedMarkersForPage } from "../../../../src/workers/phases/phase-5-embedding";
import {
  AUDIT_LOG_CONSTANTS,
  setAuditLogPrismaClientFactory,
  resetAuditLogPrismaClientFactory,
  resetAuditLogService,
  type AuditLogPrismaClient,
} from "../../../../src/services/audit-log.service";
import { AUDIT_ACTION_EMBEDDING_SECTION_VISUAL_PII_EXCLUDED } from "../../../../src/audit/audit-actions";
import { seedSectionEmbedding, cleanupSeededWebPage } from "./_fixtures/seed-large-page";

const MCP_SERVER_SRC_ROOT = path.resolve(__dirname, "../../../../src");

/**
 * The 3 canonical section_visual pending-query callsites (ADR-0018 Amendment,
 * System B / PR-C4 Path A). Each MUST reference the SSOT
 * `sectionVisualPendingExclusionPredicate` helper rather than inline its WHERE.
 */
const CANONICAL_CALLSITES = [
  "services/backfill-status.helper.ts",
  "services/embedding-backfill.service.ts",
  "workers/phases/phase-5-embedding.ts",
] as const;

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(MCP_SERVER_SRC_ROOT, relPath), "utf8");
}

/** Build a 7-category snapshot; `pendingCategories` are left pending (>0). */
function buildSnapshot(
  pendingCategories: EmbeddingBackfillCategory[]
): Record<EmbeddingBackfillCategory, number> {
  const snap = {} as Record<EmbeddingBackfillCategory, number>;
  for (const c of EMBEDDING_BACKFILL_CATEGORIES) snap[c] = 0;
  for (const c of pendingCategories) snap[c] = 1;
  return snap;
}

describe("INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011: section_visual PII-excluded terminal (PR-C4 Path A + Path B)", () => {
  beforeEach(() => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011"
    );
  });

  // ==========================================================================
  // Path A (query-level) — pending PII filter symmetric with the work side
  // ==========================================================================

  it("INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011: Path A — SSOT predicate carries a PII NOT EXISTS filter on component_parts.pii_risk_level='high'", () => {
    const fragment = sectionVisualPendingExclusionPredicate("se");
    // The pending predicate must exclude high-PII sections symmetrically with the
    // work-side `highPiiSectionIdSet` exclusion (root-cause closure).
    expect(
      /NOT EXISTS/i.test(fragment),
      "section_visual pending predicate MUST exclude high-PII sections via NOT EXISTS (Path A PII symmetry)"
    ).toBe(true);
    expect(fragment).toContain("component_parts");
    expect(fragment).toContain("pii_risk_level");
    expect(fragment).toContain("'high'");
  });

  it("INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011: Path A — all 3 canonical callsites reference the SSOT sectionVisualPendingExclusionPredicate (no inline WHERE)", () => {
    for (const relPath of CANONICAL_CALLSITES) {
      const src = readSrc(relPath);
      expect(
        src.includes("sectionVisualPendingExclusionPredicate"),
        `${relPath} MUST reference the SSOT sectionVisualPendingExclusionPredicate (partial application would re-open the permanent-pending PII asymmetry)`
      ).toBe(true);
    }
  });

  it("INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011: Path A — all 3 canonical callsites import the SSOT predicate from workers/phases/types (AST-pin)", () => {
    const project = createAstProject();
    for (const relPath of CANONICAL_CALLSITES) {
      const sf = addMcpServerSourceFile(project, `src/${relPath}`);
      const importsPredicate = sf
        .getImportDeclarations()
        .some((d) =>
          d.getNamedImports().some((n) => n.getName() === "sectionVisualPendingExclusionPredicate")
        );
      expect(
        importsPredicate,
        `${relPath} MUST import sectionVisualPendingExclusionPredicate from the SSOT module (drift guard)`
      ).toBe(true);
    }
  });

  // ==========================================================================
  // Orthogonality — real-leak (non-PII) sections stay pending (ADR §7.5)
  // ==========================================================================

  it("INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011: orthogonality — predicate still encodes vision_skip_reason IS NULL so non-PII real-leak rows stay pending", () => {
    const fragment = sectionVisualPendingExclusionPredicate("se");
    // A non-PII section with both vision_embedding NULL and vision_skip_reason NULL
    // must remain pending (real-leak / retry target). The predicate must still
    // carry the base conjuncts alongside the new PII filter.
    expect(fragment).toContain("se.text_embedding IS NOT NULL");
    expect(fragment).toContain("se.vision_embedding IS NULL");
    expect(fragment).toContain("se.vision_skip_reason IS NULL");
    // Parameter-free static fragment (no leading AND/WHERE, no reason-literal
    // interpolation → no SQL-injection surface).
    expect(fragment.startsWith("AND")).toBe(false);
    expect(fragment.startsWith("WHERE")).toBe(false);
  });

  // ==========================================================================
  // Path B (row-level marker) — work-side PII-exclusion writes the GDPR Art.30 trail
  // ==========================================================================

  it("INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011: Path B — work-side PII-exclusion site writes the section_visual_pii_excluded marker", () => {
    const phase5 = readSrc("workers/phases/phase-5-embedding.ts");
    // The work side excludes high-PII sections via highPiiSectionIdSet; the marker
    // is written at that exclusion site (NOT inside processSingleSectionVisualEmbedding,
    // which high-PII sections never reach).
    expect(phase5).toContain("highPiiSectionIdSet");
    expect(
      phase5.includes("section_visual_pii_excluded"),
      "phase-5-embedding.ts MUST write the section_visual_pii_excluded terminal marker at the work-side PII-exclusion site (GDPR Art.30 trail)"
    ).toBe(true);
  });

  it("INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011: Path B (SEC-RV1-03 / U1) — marker audit emit routes targetId through the truncateAuditTargetId SSOT", () => {
    // SEC-RV1-03 (CWE-209 PII minimisation, ADR-0032 canonical pattern): the
    // work-side marker's audit emit MUST truncate the target id via the SSOT.
    const phase5 = readSrc("workers/phases/phase-5-embedding.ts");
    expect(
      phase5.includes("truncateAuditTargetId"),
      "phase-5-embedding.ts marker audit emit MUST route targetId through the truncateAuditTargetId SSOT (SEC-RV1-03 CWE-209)"
    ).toBe(true);
  });

  it("INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011: Path B — section_visual_pii_excluded is an SSOT-derived terminal subset member (no hardcoded literal)", () => {
    // EMBEDDING_SECTION_VISUAL_SKIP_REASONS is derived from EMBEDDING_SKIP_REASONS
    // via .filter(); the new reason MUST be present in BOTH (drift guard).
    expect(EMBEDDING_SECTION_VISUAL_SKIP_REASONS as readonly string[]).toContain(
      "section_visual_pii_excluded"
    );
    expect(EMBEDDING_SKIP_REASONS as readonly string[]).toContain("section_visual_pii_excluded");
    // The full SSOT-derived terminal subset is now the 6-value set (ADR-0018
    // Amendment 13 added `screenshot_truncated_expired` additively to the prior 5;
    // `screenshot_truncated` is writable but NON-terminal so it is NOT here).
    expect([...EMBEDDING_SECTION_VISUAL_SKIP_REASONS].sort()).toEqual([
      "screenshot_truncated_expired",
      "section_visual_blank",
      "section_visual_duplicate",
      "section_visual_no_position",
      "section_visual_pii_excluded",
      "section_visual_uncroppable",
    ]);
    // Every derived value is a member of the SSOT (derived, never hardcoded).
    for (const reason of EMBEDDING_SECTION_VISUAL_SKIP_REASONS) {
      expect(EMBEDDING_SKIP_REASONS as readonly string[]).toContain(reason);
    }
  });

  // ==========================================================================
  // Terminal → completed — skipReasonToBackfillStatus + verifyCategoryParity
  // ==========================================================================

  it("INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011: terminal mapping — skipReasonToBackfillStatus('section_visual_pii_excluded') ⇒ not_required (page completable, NOT skipped_fork_error)", () => {
    // AST-pin the exhaustive switch case for the new reason → not_required.
    // skipReasonToBackfillStatus lives in page-analyze-worker.ts.
    const worker = readSrc("workers/page-analyze-worker.ts");
    // The case label must exist (exhaustive switch); group with the existing
    // section_visual_duplicate / section_visual_uncroppable terminal-skip arm.
    expect(
      worker.includes("section_visual_pii_excluded"),
      "skipReasonToBackfillStatus() MUST have a case for section_visual_pii_excluded mapping to not_required"
    ).toBe(true);
    // Negative drift guard: it MUST NOT be routed into the skipped_fork_error
    // retry bucket (that would re-create the false-failed permanent pin).
    expect(worker).not.toMatch(
      /case\s+"section_visual_pii_excluded":[\s\S]{0,120}?return\s+"skipped_fork_error"/
    );
  });

  it("INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011: green path — high-PII section excluded from pending (section_visual pending=0) ⇒ verifyCategoryParity completed-eligible", () => {
    // With Path A excluding the high-PII section from pending, section_visual
    // pending = 0; if all other categories are drained, parity ⇒ ok (completed).
    expect(verifyCategoryParity(buildSnapshot([])).ok).toBe(true);
  });

  it("INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011: red path — a residual section_visual pending (PRE-fix PII asymmetry) ⇒ verifyCategoryParity NOT completed", () => {
    // PRE-Path-A: the high-PII section counted as section_visual pending=1 forever
    // → parity NOT ok → page stuck in_progress. This is the exact infinite-loop
    // state the fix eliminates.
    const sectionVisualResidual = buildSnapshot(["section_visual"]);
    expect(verifyCategoryParity(sectionVisualResidual).ok).toBe(false);
  });
});

// ============================================================================
// Path B (runtime fault-injection) — PR-C4 B6 / TPA-RV2-01 hoist closure
//
// SEC/TPA共通指摘: 上記の Path B test は `.includes()` / `toContain()` の **静的
// 文字列 check** のみで、marker が実際に DB に書かれ audit row が emit される
// ことを runtime で証明していなかった。本 describe は w3.org 相当の
// **high-PII-only pending** 状態を実 DB に inject し、`emitSectionVisualPii
// ExcludedMarkersForPage`（work-loop / backfill 両 path が経由する SSOT entry
// point）を直接起動して:
//   (a) `section_embeddings.vision_skip_reason = 'section_visual_pii_excluded'`
//       行が **実際に set される**
//   (b) `audit_logs` に `embedding_section_visual_pii_excluded` action 行が
//       **実際に emit される** (GDPR Art.30 trail)
// を runtime で assert する (directive ⑤ no-fake-success: 「hoist した」ではなく
// 「w3.org 相当状態で実際に marker 行 + audit 行が発火する」を証明)。
//
// The static Path B tests above only checked source strings. This block injects
// the w3.org-equivalent **high-PII-only pending** state into the real DB and
// invokes the SSOT marker entry point exercised by BOTH the work-loop and the
// backfill early-return, asserting the marker row + GDPR Art.30 audit row are
// actually written at runtime (TPA-RV2-01 hoist closure).
// ============================================================================

const INV_NAME = "INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011";

/**
 * Insert a single component_part with the given pii_risk_level under
 * `sectionPatternId` (raw SQL — the section_visual high-PII detection EXISTS
 * subquery keys on `component_parts.section_pattern_id` + `pii_risk_level`).
 */
async function seedComponentPart(
  prisma: PrismaClient,
  webPageId: string,
  sectionPatternId: string,
  piiRiskLevel: "high" | "low"
): Promise<string> {
  const partId = randomUUID();
  await prisma.componentPart.create({
    data: {
      id: partId,
      webPageId,
      sectionPatternId,
      partType: "navigation",
      partSubtype: "primary",
      computedStyles: {},
      attributes: {},
      boundingBox: { x: 0, y: 0, width: 100, height: 40 },
      interactionInfo: {},
      piiRiskLevel,
      extractedAt: new Date(),
    },
  });
  return partId;
}

describe("INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011: Path B runtime fault-injection (PR-C4 B6 / TPA-RV2-01 hoist closure)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        `[${INV_NAME}] DATABASE_URL not set by globalSetup (testcontainer boot failure?)`
      );
    }
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", INV_NAME);
    // Wire the REAL test DB into the AuditLogService DI so the GDPR Art.30 audit
    // emit actually writes an audit_logs row (no-fake-success: prove the row).
    setAuditLogPrismaClientFactory(() => prisma as unknown as AuditLogPrismaClient);
    resetAuditLogService();
  });

  afterEach(() => {
    resetAuditLogPrismaClientFactory();
    resetAuditLogService();
  });

  it("INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011: Path B runtime — high-PII-only pending section ⇒ marker row + GDPR Art.30 audit row actually fire", async () => {
    // Inject the w3.org-equivalent state: a page whose ONLY pending section is
    // high-PII. seedSectionEmbedding creates a section_embeddings row with
    // text_embedding present + vision_embedding NULL + vision_skip_reason NULL
    // (the section_visual pending state). The high-PII child component_part makes
    // queryHighPiiPendingSectionPatternIds() match it.
    const webPageId = randomUUID();
    const url = `https://example.com/pii-only-test/${webPageId}`;
    await prisma.webPage.create({
      data: {
        id: webPageId,
        url,
        title: "PR-C4 B6 high-PII-only fixture",
        sourceType: "user_provided",
        usageScope: "inspiration_only",
        embeddingBackfillStatus: "in_progress",
        analysisStatus: "completed",
      },
    });

    try {
      const { sectionPatternId, sectionEmbeddingId } = await seedSectionEmbedding(
        prisma,
        webPageId,
        { sectionType: "navigation", positionIndex: 0, startY: 0, height: 400 }
      );
      // The high-PII child part — this is what makes the section high-PII and
      // thus excluded from `sectionsNeedingVisual` / `pendingCount` (so the
      // marker write was previously unreachable on an all-high-PII page).
      await seedComponentPart(prisma, webPageId, sectionPatternId, "high");

      // Pre-conditions (sanity): pending predicate excludes this high-PII section
      // (pendingCount === 0) yet the row is still pending (vision NULL + skip NULL).
      const preMarker = await prisma.$queryRawUnsafe<Array<{ vision_skip_reason: string | null }>>(
        `SELECT vision_skip_reason FROM section_embeddings WHERE id = $1::uuid`,
        sectionEmbeddingId
      );
      expect(preMarker[0]?.vision_skip_reason).toBeNull();

      // Record audit baseline for this target (truncated id) BEFORE invoking.
      const truncatedTargetId =
        webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...";
      const auditBefore = await prisma.auditLog.count({
        where: {
          action: AUDIT_ACTION_EMBEDDING_SECTION_VISUAL_PII_EXCLUDED,
          targetId: truncatedTargetId,
        },
      });

      // ---- INVOKE the SSOT marker entry point (work-loop + backfill both use it).
      const marked = await emitSectionVisualPiiExcludedMarkersForPage(prisma, webPageId);

      // (return) at least the one high-PII section was found.
      expect(marked).toBeGreaterThanOrEqual(1);

      // (a) The section row's vision_skip_reason was ACTUALLY set to the marker.
      const postMarker = await prisma.$queryRawUnsafe<Array<{ vision_skip_reason: string | null }>>(
        `SELECT vision_skip_reason FROM section_embeddings WHERE id = $1::uuid`,
        sectionEmbeddingId
      );
      expect(postMarker[0]?.vision_skip_reason).toBe("section_visual_pii_excluded");

      // (b) A GDPR Art.30 audit_logs row was ACTUALLY emitted for this target.
      const auditAfter = await prisma.auditLog.count({
        where: {
          action: AUDIT_ACTION_EMBEDDING_SECTION_VISUAL_PII_EXCLUDED,
          targetId: truncatedTargetId,
        },
      });
      expect(auditAfter).toBe(auditBefore + 1);

      // CWE-209: the audit targetId is truncated (SSOT truncateAuditTargetId), so
      // the full webPageId never appears in audit_logs.target_id.
      const fullIdRow = await prisma.auditLog.count({
        where: {
          action: AUDIT_ACTION_EMBEDDING_SECTION_VISUAL_PII_EXCLUDED,
          targetId: webPageId,
        },
      });
      expect(fullIdRow).toBe(0);
    } finally {
      await cleanupSeededWebPage(prisma, webPageId);
    }
  });

  it("INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011: Path B runtime — idempotent (re-invoke after marker set ⇒ no double-emit)", async () => {
    // After the marker terminalizes the row, queryHighPiiPendingSectionPatternIds
    // returns the empty set (vision_skip_reason IS NULL excludes it), so a second
    // invocation emits NO further marker / audit (no double-emit across paths).
    const webPageId = randomUUID();
    const url = `https://example.com/pii-only-idempotent/${webPageId}`;
    await prisma.webPage.create({
      data: {
        id: webPageId,
        url,
        title: "PR-C4 B6 idempotency fixture",
        sourceType: "user_provided",
        usageScope: "inspiration_only",
        embeddingBackfillStatus: "in_progress",
        analysisStatus: "completed",
      },
    });

    try {
      const { sectionPatternId } = await seedSectionEmbedding(prisma, webPageId, {
        sectionType: "navigation",
        positionIndex: 0,
        startY: 0,
        height: 400,
      });
      await seedComponentPart(prisma, webPageId, sectionPatternId, "high");

      const truncatedTargetId =
        webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...";

      // First invocation marks + emits once.
      const firstMarked = await emitSectionVisualPiiExcludedMarkersForPage(prisma, webPageId);
      expect(firstMarked).toBeGreaterThanOrEqual(1);
      const auditAfterFirst = await prisma.auditLog.count({
        where: {
          action: AUDIT_ACTION_EMBEDDING_SECTION_VISUAL_PII_EXCLUDED,
          targetId: truncatedTargetId,
        },
      });
      expect(auditAfterFirst).toBe(1);

      // Second invocation: empty set → no marker, no audit (idempotent).
      const secondMarked = await emitSectionVisualPiiExcludedMarkersForPage(prisma, webPageId);
      expect(secondMarked).toBe(0);
      const auditAfterSecond = await prisma.auditLog.count({
        where: {
          action: AUDIT_ACTION_EMBEDDING_SECTION_VISUAL_PII_EXCLUDED,
          targetId: truncatedTargetId,
        },
      });
      expect(auditAfterSecond).toBe(1); // unchanged → no double-emit
    } finally {
      await cleanupSeededWebPage(prisma, webPageId);
    }
  });

  it("INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011: Path B runtime — non-PII pending section is NOT marked (orthogonality: real-leak stays pending)", async () => {
    // A non-high-PII pending section must NOT receive the PII-excluded marker
    // (it is a real-leak / retry target, not an intentional PII exclusion).
    const webPageId = randomUUID();
    const url = `https://example.com/non-pii-pending/${webPageId}`;
    await prisma.webPage.create({
      data: {
        id: webPageId,
        url,
        title: "PR-C4 B6 non-PII orthogonality fixture",
        sourceType: "user_provided",
        usageScope: "inspiration_only",
        embeddingBackfillStatus: "in_progress",
        analysisStatus: "completed",
      },
    });

    try {
      const { sectionPatternId, sectionEmbeddingId } = await seedSectionEmbedding(
        prisma,
        webPageId,
        { sectionType: "feature", positionIndex: 0, startY: 0, height: 400 }
      );
      // LOW-PII child → section is a genuine pending (real-leak), not PII-excluded.
      await seedComponentPart(prisma, webPageId, sectionPatternId, "low");

      const marked = await emitSectionVisualPiiExcludedMarkersForPage(prisma, webPageId);
      expect(marked).toBe(0);

      const row = await prisma.$queryRawUnsafe<Array<{ vision_skip_reason: string | null }>>(
        `SELECT vision_skip_reason FROM section_embeddings WHERE id = $1::uuid`,
        sectionEmbeddingId
      );
      // Still pending (no marker) → real-leak retry target preserved.
      expect(row[0]?.vision_skip_reason).toBeNull();
    } finally {
      await cleanupSeededWebPage(prisma, webPageId);
    }
  });
});
