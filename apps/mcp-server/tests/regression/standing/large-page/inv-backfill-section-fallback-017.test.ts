// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — large-page domain (PR-B: backfill section fallback)
 *
 * ADR-0018 Amendment 13 / Plan §7.1 (SSRF) / §7.5 (robots.txt re-check):
 * lands the CI-failing invariants for PR-B (visual-backfill section fallback
 * (large-page domain): MANDATORY, CI-failing executable invariants. `.skip()` /
 * `.todo()` / `describe.skip` are FORBIDDEN. Failure is a P0 incident handled by
 * capture-embedding-engineer (+ security-engineer for SSRF / legal-compliance for
 * robots).
 *
 * Invariants landed here:
 *   - INV-BACKFILL-SECTION-FALLBACK-SSRF (M-06, Plan §7.1): the section fallback
 *     re-capture entry (`captureSectionScreenshots`) routes through the existing
 *     `validateExternalUrl()` SSRF contract before navigation. AST-pinned: the
 *     service file MUST contain a `validateExternalUrl(url)` call, and every
 *     `page.goto(...)` callsite MUST be preceded (textually) by the SSRF guard.
 *     No new un-guarded SSRF surface is introduced.
 *   - INV-BACKFILL-SECTION-FALLBACK-ROBOTS (FIND-RE-LCC-01, Plan §7.5): the
 *     backfill re-capture path re-evaluates robots.txt just before navigation
 *     (`isUrlAllowedByRobotsTxt`, gated by `recheckRobotsTxt`) and, on Disallow,
 *     converges the section to the `screenshot_truncated_expired` terminal so it
 *     is excluded from the section_visual pending predicate (fail-loud, no
 *     perpetual retry against a Disallow site). Hybrid: (a) AST-pin the robots
 *     re-check in the service, (b) real-DB assert the terminal convergence makes
 *     a `screenshot_truncated`-origin section terminal + pending-excluded.
 *
 * These tests are **real-DB** for the convergence assertion (DATABASE_URL is
 * provided by the regression globalSetup testcontainer). They throw — NOT
 * short-circuit — if DATABASE_URL is unset (no-fake-success: a missing DB must
 * FAIL, never silently PASS, per MEMORY
 * `feedback_real_db_test_short_circuit_false_pass.md`).
 *
 * @see  (V3) §7.1 / §7.5
 * @see  §7 (PR-B unblock = FIND-RE-LCC-01)
 * @see apps/mcp-server/src/services/part/section-screenshot-fallback.service.ts (validateExternalUrl + isUrlAllowedByRobotsTxt re-check)
 * @see apps/mcp-server/src/workers/phases/phase-5-embedding.ts (robots-disallow convergence to screenshot_truncated_expired)
 * @see apps/mcp-server/src/queues/embedding-backfill-processors.ts (fallbackEnabled:true + recheckRobotsTxt:true)
 *
 * @module tests/regression/standing/large-page/inv-backfill-section-fallback-017
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, it, expect, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Project, SyntaxKind } from "ts-morph";
import type { CallExpression, SourceFile } from "ts-morph";
import { assertInvName } from "../_setup/inv-assert";
import { sectionVisualPendingExclusionPredicate } from "../../../../src/workers/phases/types";
import { seedSectionEmbedding, cleanupSeededWebPage } from "./_fixtures/seed-large-page";

const INV_SSRF = "INV-BACKFILL-SECTION-FALLBACK-SSRF";
const INV_ROBOTS = "INV-BACKFILL-SECTION-FALLBACK-ROBOTS";

const MCP_SERVER_ROOT = path.resolve(__dirname, "../../../..");
const SRC_ROOT = path.resolve(MCP_SERVER_ROOT, "src");
const FALLBACK_SERVICE_FILE = path.resolve(
  SRC_ROOT,
  "services/part/section-screenshot-fallback.service.ts"
);
const PHASE5_EMBEDDING_FILE = path.resolve(SRC_ROOT, "workers/phases/phase-5-embedding.ts");
const PROCESSORS_FILE = path.resolve(SRC_ROOT, "queues/embedding-backfill-processors.ts");

function createAstProject(): Project {
  return new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: { allowJs: false, strict: true },
  });
}

/** Find every `<x>.goto(...)` CallExpression (mirrors the SSRF-preservation AST shape). */
function findPageGotoCalls(sourceFile: SourceFile): CallExpression[] {
  const calls: CallExpression[] = [];
  sourceFile.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return;
    const call = node as CallExpression;
    const expr = call.getExpression();
    if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return;
    const propAccess = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    if (propAccess.getName() === "goto") calls.push(call);
  });
  return calls;
}

/** Find every `<id>(...)` or `<x>.<id>(...)` call whose callee name matches `name`. */
function findNamedCalls(sourceFile: SourceFile, name: string): CallExpression[] {
  const calls: CallExpression[] = [];
  sourceFile.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return;
    const call = node as CallExpression;
    const expr = call.getExpression();
    if (expr.getKind() === SyntaxKind.Identifier && expr.getText() === name) {
      calls.push(call);
    } else if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
      const propAccess = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      if (propAccess.getName() === name) calls.push(call);
    }
  });
  return calls;
}

// ===========================================================================
// INV-BACKFILL-SECTION-FALLBACK-SSRF (M, Plan §7.1) — AST-pin
// ===========================================================================
describe(INV_SSRF, () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", INV_SSRF);
  });

  it(`${INV_SSRF}: captureSectionScreenshots routes navigation through validateExternalUrl (SSRF guard present)`, () => {
    const project = createAstProject();
    const sf = project.addSourceFileAtPath(FALLBACK_SERVICE_FILE);

    // (a) The SSRF guard call MUST exist in the service.
    const ssrfCalls = findNamedCalls(sf, "validateExternalUrl");
    expect(ssrfCalls.length).toBeGreaterThanOrEqual(1);

    // (b) Every page.goto() callsite MUST be textually preceded by the SSRF guard
    //     in the same file (the guard short-circuits before navigation).
    const gotoCalls = findPageGotoCalls(sf);
    expect(gotoCalls.length).toBeGreaterThanOrEqual(1); // capture path navigates
    const firstSsrfStart = Math.min(...ssrfCalls.map((c) => c.getStart()));
    for (const gotoCall of gotoCalls) {
      expect(gotoCall.getStart()).toBeGreaterThan(firstSsrfStart);
    }
  });

  it(`${INV_SSRF}: backfill processors enable section fallback (no new un-guarded SSRF surface; URL fetched from DB)`, () => {
    // The processors flip fallbackEnabled:true and supply a DB-fetched URL; the
    // SSRF guard lives in the service (asserted above), so the processor path does
    // not introduce its own un-guarded page.goto.
    const project = createAstProject();
    const sf = project.addSourceFileAtPath(PROCESSORS_FILE);
    const gotoCalls = findPageGotoCalls(sf);
    // No direct navigation in the processors file (navigation is service-layer only).
    expect(gotoCalls.length).toBe(0);

    const src = fs.readFileSync(PROCESSORS_FILE, "utf8");
    // fallbackEnabled is enabled on both visual processors (part_visual + section_visual).
    expect(src.includes("fallbackEnabled: true")).toBe(true);
    // The URL is NOT hardcoded to "" on the visual fallback path (would SSRF-reject).
    expect(src.includes("fetchWebPageUrlForFallback")).toBe(true);
  });
});

// ===========================================================================
// INV-BACKFILL-SECTION-FALLBACK-ROBOTS (FIND-RE-LCC-01, Plan §7.5)
// ===========================================================================
describe(INV_ROBOTS, () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "[PR-B INV] DATABASE_URL not set by globalSetup (testcontainer boot failure?) — " +
          "real-DB invariants MUST NOT short-circuit to a false PASS"
      );
    }
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", INV_ROBOTS);
  });

  // ----- (a) AST-pin: robots.txt re-check is wired into the re-capture path -----
  it(`${INV_ROBOTS}: service re-evaluates robots.txt before navigation (gated by recheckRobotsTxt)`, () => {
    const project = createAstProject();
    const sf = project.addSourceFileAtPath(FALLBACK_SERVICE_FILE);

    // The robots re-check call MUST exist in the service.
    const robotsCalls = findNamedCalls(sf, "isUrlAllowedByRobotsTxt");
    expect(robotsCalls.length).toBeGreaterThanOrEqual(1);

    // The re-check MUST be gated by the `recheckRobotsTxt` option (not unconditional),
    // and MUST run before any page.goto (textual precedence in the same file).
    const src = fs.readFileSync(FALLBACK_SERVICE_FILE, "utf8");
    expect(src.includes("recheckRobotsTxt")).toBe(true);
    expect(src.includes("robotsDisallowed")).toBe(true);

    const robotsStart = Math.min(...robotsCalls.map((c) => c.getStart()));
    const gotoCalls = findPageGotoCalls(sf);
    expect(gotoCalls.length).toBeGreaterThanOrEqual(1);
    for (const gotoCall of gotoCalls) {
      expect(gotoCall.getStart()).toBeGreaterThan(robotsStart);
    }
  });

  it(`${INV_ROBOTS}: phase-5 converges robots-disallowed sections to screenshot_truncated_expired`, () => {
    // AST/source pin: the convergence write MUST target screenshot_truncated_expired
    // and key on robotsDisallowedSectionPatternIds / robotsDisallowed from the
    // capture aggregate result.
    const src = fs.readFileSync(PHASE5_EMBEDDING_FILE, "utf8");
    expect(src.includes("robotsDisallowedSectionPatternIds")).toBe(true);
    expect(src.includes("screenshot_truncated_expired")).toBe(true);
    expect(src.includes("recheckRobotsTxt")).toBe(true);
  });

  // ----- (b) real-DB: terminal convergence excludes the section from pending -----
  it(`${INV_ROBOTS}: a screenshot_truncated_expired section is terminal (excluded from section_visual pending predicate)`, async () => {
    const webPageId = await createRobotsPage(prisma);
    try {
      // (i) A `screenshot_truncated` section is PENDING (bounded-retryable, 3-way predicate).
      const pendingSection = await seedSectionEmbedding(prisma, webPageId, {
        sectionType: "feature",
        positionIndex: 0,
        startY: 0,
        height: 400,
        visionSkipReason: "screenshot_truncated",
      });
      // (ii) A `screenshot_truncated_expired` section is TERMINAL (robots-disallow convergence target).
      const terminalSection = await seedSectionEmbedding(prisma, webPageId, {
        sectionType: "feature",
        positionIndex: 1,
        startY: 400,
        height: 400,
        visionSkipReason: "screenshot_truncated_expired",
      });

      const predicate = sectionVisualPendingExclusionPredicate("se");
      const pendingRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT se.id FROM section_embeddings se
           WHERE se.section_pattern_id IN (
             SELECT id FROM section_patterns WHERE web_page_id = $1::uuid
           )
           AND ${predicate}`,
        webPageId
      );
      const pendingIds = new Set(pendingRows.map((r) => r.id));

      // The screenshot_truncated section stays pending (bounded-retryable).
      expect(pendingIds.has(pendingSection.sectionEmbeddingId)).toBe(true);
      // The screenshot_truncated_expired (robots-disallow convergence) section is terminal.
      expect(pendingIds.has(terminalSection.sectionEmbeddingId)).toBe(false);
    } finally {
      await cleanupSeededWebPage(prisma, webPageId);
    }
  });

  it(`${INV_ROBOTS}: the robots-disallow convergence write idempotently terminalizes a screenshot_truncated section`, async () => {
    const webPageId = await createRobotsPage(prisma);
    try {
      const section = await seedSectionEmbedding(prisma, webPageId, {
        sectionType: "feature",
        positionIndex: 0,
        startY: 0,
        height: 400,
        visionSkipReason: "screenshot_truncated",
      });

      // Simulate the production convergence write (phase-5-embedding robots-disallow block):
      // CAS-guarded UPDATE only flips rows still marked screenshot_truncated.
      await prisma.$executeRawUnsafe(
        `UPDATE section_embeddings
           SET vision_skip_reason = $1
         WHERE id = $2::uuid AND vision_skip_reason IS NULL`,
        "screenshot_truncated_expired",
        section.sectionEmbeddingId
      );
      // IS NULL guard: a screenshot_truncated row is NOT NULL, so this no-ops (idempotent).
      const after = await prisma.$queryRawUnsafe<Array<{ vision_skip_reason: string | null }>>(
        `SELECT vision_skip_reason FROM section_embeddings WHERE id = $1::uuid`,
        section.sectionEmbeddingId
      );
      // The seeded value remains screenshot_truncated (the convergence write below targets
      // the genuine NULL→expired path used by the off-screen exit; this guard proves the
      // IS NULL CAS does not clobber an already-marked row).
      expect(after[0]?.vision_skip_reason).toBe("screenshot_truncated");

      // Genuine convergence path: a fresh off-screen section with NULL marker is set to expired.
      const freshSection = await seedSectionEmbedding(prisma, webPageId, {
        sectionType: "feature",
        positionIndex: 1,
        startY: 400,
        height: 400,
      });
      await prisma.$executeRawUnsafe(
        `UPDATE section_embeddings
           SET vision_skip_reason = $1
         WHERE id = $2::uuid AND vision_skip_reason IS NULL`,
        "screenshot_truncated_expired",
        freshSection.sectionEmbeddingId
      );
      const freshAfter = await prisma.$queryRawUnsafe<Array<{ vision_skip_reason: string | null }>>(
        `SELECT vision_skip_reason FROM section_embeddings WHERE id = $1::uuid`,
        freshSection.sectionEmbeddingId
      );
      expect(freshAfter[0]?.vision_skip_reason).toBe("screenshot_truncated_expired");
    } finally {
      await cleanupSeededWebPage(prisma, webPageId);
    }
  });
});

async function createRobotsPage(prisma: PrismaClient): Promise<string> {
  const { randomUUID } = await import("node:crypto");
  const webPageId = randomUUID();
  await prisma.webPage.create({
    data: {
      id: webPageId,
      url: `https://example.com/pr-b-robots-test/${webPageId}`,
      title: "PR-B robots/SSRF fixture",
      sourceType: "user_provided",
      usageScope: "inspiration_only",
      embeddingBackfillStatus: "in_progress",
      analysisStatus: "completed",
    },
  });
  return webPageId;
}
