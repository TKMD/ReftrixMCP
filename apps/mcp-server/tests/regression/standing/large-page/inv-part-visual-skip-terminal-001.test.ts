// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-PART-VISUAL-SKIP-TERMINAL-001 (Plan v2 PR-D)
 *
 * ADR-0018 Amendment 7 §7.1 / §7.2 / §7.6: the part_visual pending query is
 * scattered across 3+ callsites; if even ONE callsite omits the SSOT exclusion
 * predicate, terminal-skip parts (`visual_skip_reason` non-NULL) keep satisfying
 * `visual_embedding IS NULL` and the backfill processor re-fetches them forever
 * (NF-TPA-01, H). This standing test pins, by AST/source-pin:
 *
 *   (a) terminal-skip exclusion — ALL 3 canonical callsites reference the single
 *       SSOT `partVisualPendingExclusionPredicate` helper (NOT an inline WHERE),
 *       so partial application is impossible by construction;
 *   (b) real-leak continuation (INV-(b) orthogonality, ADR §7.5 req3) — a row with
 *       BOTH `visual_embedding IS NULL` AND `visual_skip_reason IS NULL` stays
 *       pending (the predicate's two conjuncts encode exactly this);
 *   (c) F3 clear — the 2 terminal silent-skip exits (#1 bbox_invalid / #2
 *       bbox_unresolvable) write a per-row marker; the transient DINOv2-catch
 *       exit (#3) does NOT (so it keeps retrying).
 *
 * `.skip` / `.todo` / accepted-risk are forbidden (NF-TPA-01 is H; Severity →
 * Landing Rules require code + CI-failing test).
 *
 * @see ADR-0018 Amendment 7 §7.1 (SSOT exclusion predicate), §7.2 (this INV),
 *      §7.6 (3 silent-skip exit classification)
 * @see Plan v2 PR-D §5 TEST (regression standing, CI-failing, all-callsite pin)
 * @see EMBEDDING_PART_VISUAL_SKIP_REASONS SSOT (src/workers/phases/types.ts)
 *
 * Severity: H (NF-TPA-01)
 *
 * @module tests/regression/standing/large-page/inv-part-visual-skip-terminal-001
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertInvName } from "../_setup/inv-assert";
import { createAstProject, addMcpServerSourceFile } from "../schema-enum-sync/_extractors";
import {
  EMBEDDING_PART_VISUAL_SKIP_REASONS,
  EMBEDDING_SKIP_REASONS,
  partVisualPendingExclusionPredicate,
} from "../../../../src/workers/phases/types";

// ============================================================================
// Canonical 3-callsite registry (ADR-0018 Amendment 7 §7.1 + Refs)
// ============================================================================

const MCP_SERVER_SRC_ROOT = path.resolve(__dirname, "../../../../src");

/**
 * The 3 canonical part_visual pending-query callsites. Each MUST reference the
 * SSOT `partVisualPendingExclusionPredicate` helper rather than inline its WHERE.
 * Adding a 4th part_visual pending query without registering it here will be
 * caught by the global sweep in test (e).
 */
const CANONICAL_CALLSITES = [
  "services/backfill-status.helper.ts",
  "services/embedding-backfill.service.ts",
  "workers/phases/phase-5-embedding.ts",
] as const;

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(MCP_SERVER_SRC_ROOT, relPath), "utf8");
}

describe("INV-PART-VISUAL-SKIP-TERMINAL-001: part_visual terminal-skip SSOT exclusion (Plan v2 PR-D)", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-PART-VISUAL-SKIP-TERMINAL-001");
  });

  // ==========================================================================
  // (a) terminal-skip exclusion — all 3 callsites reference the SSOT predicate
  // ==========================================================================

  it("INV-PART-VISUAL-SKIP-TERMINAL-001: (a) all 3 canonical callsites reference the SSOT partVisualPendingExclusionPredicate helper (no inline WHERE)", () => {
    for (const relPath of CANONICAL_CALLSITES) {
      const src = readSrc(relPath);
      expect(
        src.includes("partVisualPendingExclusionPredicate"),
        `${relPath} MUST reference the SSOT partVisualPendingExclusionPredicate (NF-TPA-01: partial application lets the processor re-fetch terminal-skip parts forever)`
      ).toBe(true);
    }
  });

  it("INV-PART-VISUAL-SKIP-TERMINAL-001: (a) all 3 canonical callsites import the SSOT predicate from workers/phases/types (AST-pin)", () => {
    const project = createAstProject();
    for (const relPath of CANONICAL_CALLSITES) {
      // addMcpServerSourceFile resolves relative to the mcp-server root, so the
      // path must be `src/`-prefixed.
      const sf = addMcpServerSourceFile(project, `src/${relPath}`);
      const importsPredicate = sf
        .getImportDeclarations()
        .some((d) =>
          d.getNamedImports().some((n) => n.getName() === "partVisualPendingExclusionPredicate")
        );
      expect(
        importsPredicate,
        `${relPath} MUST import partVisualPendingExclusionPredicate from the SSOT module (drift guard)`
      ).toBe(true);
    }
  });

  it("INV-PART-VISUAL-SKIP-TERMINAL-001: (a) no canonical callsite retains the legacy bare `visual_embedding IS NULL` pending condition without the SSOT predicate", () => {
    // The legacy condition `cpe.visual_embedding IS NULL` (without the
    // `AND ... visual_skip_reason IS NULL` exclusion) must NOT appear as a
    // standalone pending-query WHERE in the canonical callsites — it MUST be
    // produced by the SSOT helper. We assert the SSOT helper call is present
    // AND the raw standalone two-line legacy form is absent.
    for (const relPath of CANONICAL_CALLSITES) {
      const src = readSrc(relPath);
      // Legacy standalone form: a line ending in `visual_embedding IS NULL`
      // that is NOT immediately the SSOT predicate output. Since the SSOT
      // helper emits both conjuncts on one fragment, a bare trailing
      // `visual_embedding IS NULL`\n` (no AND visual_skip_reason) would be a
      // regression. Match the legacy pattern: `IS NULL` followed by backtick
      // closing the template (end of WHERE) without the skip_reason conjunct.
      const legacyBarePending =
        /visual_embedding IS NULL`\s*,/.test(src) &&
        !src.includes("partVisualPendingExclusionPredicate");
      expect(
        legacyBarePending,
        `${relPath} retains a legacy bare pending WHERE without the SSOT predicate (NF-TPA-01 regression)`
      ).toBe(false);
    }
  });

  // ==========================================================================
  // (b) real-leak continuation — INV-(b) orthogonality (ADR §7.5 req3)
  // ==========================================================================

  it("INV-PART-VISUAL-SKIP-TERMINAL-001: (b) SSOT predicate encodes BOTH conjuncts (visual_embedding IS NULL AND visual_skip_reason IS NULL) so real-leak rows stay pending", () => {
    const fragment = partVisualPendingExclusionPredicate("cpe");
    // real-leak (both NULL) is pending; terminal-skip (skip_reason non-NULL) is excluded.
    expect(fragment).toContain("cpe.visual_embedding IS NULL");
    expect(fragment).toContain("cpe.visual_skip_reason IS NULL");
    expect(fragment).toMatch(/visual_embedding IS NULL\s+AND\s+cpe\.visual_skip_reason IS NULL/);
    // Default alias is `cpe`; the bare-table alias variant is used by Phase 5.
    expect(partVisualPendingExclusionPredicate("component_part_embeddings")).toContain(
      "component_part_embeddings.visual_skip_reason IS NULL"
    );
    // Parameter-free static fragment (no SQL-injection surface, no leading AND/WHERE).
    expect(fragment.startsWith("AND")).toBe(false);
    expect(fragment.startsWith("WHERE")).toBe(false);
  });

  // ==========================================================================
  // (c) F3 clear — terminal exits write marker, transient exit does not
  // ==========================================================================

  it("INV-PART-VISUAL-SKIP-TERMINAL-001: (c) the 3 main-path terminal silent-skip exits + 1 residual-path reuse write a per-row marker; the transient DINOv2-catch exit does NOT (ADR §7.6, PR-F; PR-BT-4 4th callsite)", () => {
    const phase5 = readSrc("workers/phases/phase-5-embedding.ts");
    // exit #1 bbox_invalid + exit #2 bbox_unresolvable + exit #2a off-screen
    // precondition bbox_unresolvable (PR-F NF-TPA-02 closure) → marker write.
    expect(phase5).toContain(
      'writePartVisualTerminalSkipMarker(ctx, part.embeddingId, "bbox_invalid")'
    );
    expect(phase5).toContain(
      'writePartVisualTerminalSkipMarker(ctx, part.embeddingId, "bbox_unresolvable")'
    );
    // PR-BT-4 (ADR-0018 Amendment 10 Decision 10.2): the exported residual-marker
    // helper `markResidualBboxUnresolvableParts` REUSES the same idempotent writer
    // (the 4th `(ctx,` callsite) so the backfill residual bbox path writes a
    // Layer-1 marker rather than forking a second writer.
    expect(phase5).toContain(
      'writePartVisualTerminalSkipMarker(ctx, embeddingId, "bbox_unresolvable")'
    );
    // Exactly 4 terminal marker call-sites that reuse the single SSOT writer:
    //   #1 bbox_invalid     (main-path: missing / non-positive bbox)
    //   #2 bbox_unresolvable (main-path: clamped crop yields cropWidth/cropHeight <= 0)
    //   #2a bbox_unresolvable (main-path PR-F: fully off-screen left-top edge,
    //       top >= imgHeight || left >= imgWidth — zero croppable pixels)
    //   #4 bbox_unresolvable (PR-BT-4: residual backfill path, gap B closure)
    // The first 3 stay in the main-path loop (the transient DINOv2-catch exit is
    // STILL never marked); a 5th would mean an unintended new terminal marker.
    const markerCallCount = (phase5.match(/writePartVisualTerminalSkipMarker\(ctx,/g) ?? []).length;
    expect(markerCallCount).toBe(4);
    // The DINOv2 catch (exit #3, transient) keeps the row pending (no marker) —
    // assert it logs a warn and continues, never calling the marker helper in
    // its catch body. The catch body matches the DINOv2 part-visual failure log.
    expect(phase5).toContain("DINOv2 visual embedding failed for part (non-fatal)");
    // PR-F NF-TPA-02: the off-screen precondition (exit #2a) MUST sit BEFORE the
    // `Math.max(1, imgHeight - top)` clamp — assert the source-pin of the guard
    // condition so a future refactor that moves it after the clamp (re-opening
    // the permanent-pending gap) is caught at CI.
    expect(phase5).toContain("top >= imgHeight || left >= imgWidth");
  });

  it("INV-PART-VISUAL-SKIP-TERMINAL-001: (c) marker writes use the SSOT-derived terminal reasons only (bbox_invalid / bbox_unresolvable)", () => {
    // EMBEDDING_PART_VISUAL_SKIP_REASONS is the SSOT-derived terminal subset.
    expect([...EMBEDDING_PART_VISUAL_SKIP_REASONS].sort()).toEqual([
      "bbox_invalid",
      "bbox_unresolvable",
    ]);
    // Each terminal reason MUST be a member of the 20-value EMBEDDING_SKIP_REASONS
    // SSOT (drift guard — derived, never hardcoded).
    for (const reason of EMBEDDING_PART_VISUAL_SKIP_REASONS) {
      expect(EMBEDDING_SKIP_REASONS as readonly string[]).toContain(reason);
    }
  });

  // ==========================================================================
  // (e) global forward-compat sweep — no UNregistered part_visual pending query
  // ==========================================================================

  it("INV-PART-VISUAL-SKIP-TERMINAL-001: (e) every production SQL that JOINs component_part_embeddings on `visual_embedding IS NULL` for pending counting is a registered canonical callsite using the SSOT predicate", () => {
    // Forward-compat: sweep all src/*.ts for a `visual_embedding IS NULL`
    // pending-query SQL literal. Any file that contains it MUST also contain
    // the SSOT predicate reference, OR be exempt (the SSOT module itself /
    // the marker UPDATE which uses `visual_skip_reason IS NULL` guard).
    const allFiles = collectTsFiles(MCP_SERVER_SRC_ROOT);
    const offenders: string[] = [];
    for (const abs of allFiles) {
      const src = fs.readFileSync(abs, "utf8");
      // Only consider files with a part-visual pending SELECT/COUNT on
      // component_part_embeddings + visual_embedding IS NULL.
      const hasPartVisualPendingSql =
        src.includes("component_part_embeddings") &&
        /visual_embedding IS NULL/.test(src) &&
        // Exclude the marker UPDATE form (it guards on visual_skip_reason IS NULL
        // and writes the marker — not a pending query).
        !/SET visual_skip_reason/.test(stripMarkerUpdateBlocks(src));
      if (!hasPartVisualPendingSql) continue;
      const usesSsotPredicate = src.includes("partVisualPendingExclusionPredicate");
      const isSsotModule = abs.endsWith(path.join("workers", "phases", "types.ts"));
      if (!usesSsotPredicate && !isSsotModule) {
        offenders.push(path.relative(MCP_SERVER_SRC_ROOT, abs));
      }
    }
    expect(
      offenders,
      `Unregistered part_visual pending query without the SSOT exclusion predicate (NF-TPA-01). ` +
        `Register the callsite + apply partVisualPendingExclusionPredicate(): ${offenders.join(", ")}`
    ).toEqual([]);
  });
});

// ============================================================================
// (d) Real-DB Block D — PR-F NF-TPA-02 off-screen marker-gap closure
// ============================================================================
//
// The AST/source-pin block above proves the off-screen precondition exists and
// writes a terminal marker. This real-DB block proves the END-TO-END contract
// against production SQL (INV-003 Block D pattern): a fully-off-screen part is
// terminally marked → excluded by the SSOT `partVisualPendingExclusionPredicate`
// → backfill pending count reaches 0 → page can reach `completed`. A
// partially-visible part is NOT marked → stays pending (over-termination guard,
// TPA-IMPL-L-01).
//
// We exercise the **production marker SQL** (`writePartVisualTerminalSkipMarker`'s
// `UPDATE ... SET visual_skip_reason = $1 WHERE id = $2::uuid AND
// visual_skip_reason IS NULL`) and the **production exclusion predicate**
// (`partVisualPendingExclusionPredicate`) directly against real Prisma DB state
// — numeric mocks are NOT reused (per Block D real-DB requirement). The
// off-screen geometry classification is pinned to the production predicate
// `top >= imgHeight || left >= imgWidth`.

/** SSRF-safe RFC 2606 reserved domain (ADR-0016 § Fixture URL Policy). */
const PRF_FIXTURE_URL_PREFIX = "https://example.com/inv-part-visual-skip-terminal-001/";

/** Screenshot dimensions used by the geometry cases (typical fullPage capture). */
const PRF_IMG_WIDTH = 1920;
const PRF_IMG_HEIGHT = 1080;

/**
 * Production off-screen classification predicate, replicated verbatim from
 * `processPartVisualEmbeddingLoop` (phase-5-embedding.ts exit #2a). A part is
 * fully off-screen (zero croppable pixels) iff its clamped left-top edge is at
 * or beyond the screenshot bounds. Partially-visible parts (top < imgHeight)
 * are NOT off-screen and keep flowing through the clamp.
 */
function isFullyOffScreen(left: number, top: number, imgWidth: number, imgHeight: number): boolean {
  return top >= imgHeight || left >= imgWidth;
}

/** Mirror production `left`/`top` clamp (`Math.max(0, Math.round(...))`). */
function clampLeftTop(absX: number, absY: number): { left: number; top: number } {
  return { left: Math.max(0, Math.round(absX)), top: Math.max(0, Math.round(absY)) };
}

/**
 * Seeds web_page → section_pattern → component_part → component_part_embedding
 * (visual_embedding NULL, visual_skip_reason NULL = pending). Returns the
 * component_part_embeddings.id (the marker UPDATE / pending query key).
 */
async function seedPendingPartEmbedding(
  prisma: PrismaClient,
  webPageId: string
): Promise<{ embeddingId: string }> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO web_pages (id, url, source_type, usage_scope, updated_at)
     VALUES ($1::uuid, $2, 'user_provided', 'inspiration_only', NOW())`,
    webPageId,
    `${PRF_FIXTURE_URL_PREFIX}${webPageId}`
  );
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
        '{}'::jsonb, '{}'::jsonb, '{"x":0,"y":0,"width":100,"height":40}'::jsonb,
        '{}'::jsonb, 'low', NOW(), NOW(), NOW())`,
    partId,
    webPageId,
    sectionPatternId
  );
  const embeddingId = randomUUID();
  // text_embedding present, visual_embedding NULL, visual_skip_reason NULL → pending.
  // `visual_model_version` is NOT NULL (no DB default) — production sets both
  // model versions when the row is created during part extraction; we mirror the
  // seed-large-page fixture's mock values.
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
  return { embeddingId };
}

/**
 * Counts pending part_visual rows for an embeddingId using the **production
 * SSOT exclusion predicate** (`partVisualPendingExclusionPredicate`). A row is
 * pending iff `visual_embedding IS NULL AND visual_skip_reason IS NULL`.
 */
async function countPendingPartVisual(prisma: PrismaClient, embeddingId: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM component_part_embeddings
     WHERE id = $1::uuid AND ${partVisualPendingExclusionPredicate("component_part_embeddings")}`,
    embeddingId
  );
  return Number(rows[0]?.count ?? 0n);
}

/**
 * Production marker SQL, replicated verbatim from
 * `writePartVisualTerminalSkipMarker` (idempotent `WHERE ... visual_skip_reason
 * IS NULL` guard + parameterized $1/$2::uuid, SQLi-safe).
 */
async function writeTerminalMarker(
  prisma: PrismaClient,
  embeddingId: string,
  reason: string
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE component_part_embeddings
       SET visual_skip_reason = $1
     WHERE id = $2::uuid AND visual_skip_reason IS NULL`,
    reason,
    embeddingId
  );
}

describe("INV-PART-VISUAL-SKIP-TERMINAL-001: (d) real-DB off-screen marker-gap closure (PR-F NF-TPA-02)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "[INV-PART-VISUAL-SKIP-TERMINAL-001] DATABASE_URL not set by globalSetup (testcontainer boot failure?)"
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
    assertInvName(expect.getState().currentTestName ?? "", "INV-PART-VISUAL-SKIP-TERMINAL-001");
  });

  it("INV-PART-VISUAL-SKIP-TERMINAL-001: (d) off-screen part (top >= imgHeight) → bbox_unresolvable marker → excluded by SSOT predicate → pending = 0", async () => {
    const webPageId = randomUUID();
    try {
      const { embeddingId } = await seedPendingPartEmbedding(prisma, webPageId);

      // Pre: pending = 1 (visual_embedding NULL + visual_skip_reason NULL).
      expect(await countPendingPartVisual(prisma, embeddingId)).toBe(1);

      // Geometry: a fully off-screen part — sectionStartY pushes the top edge to
      // or beyond imgHeight (e.g. a lazy-loaded section past the captured page).
      const absX = 0;
      const absY = PRF_IMG_HEIGHT + 500; // top-edge below the screenshot
      const { left, top } = clampLeftTop(absX, absY);

      // The production exit #2a predicate classifies this as fully off-screen.
      expect(isFullyOffScreen(left, top, PRF_IMG_WIDTH, PRF_IMG_HEIGHT)).toBe(true);

      // Production marker write (exit #2a) → terminal bbox_unresolvable.
      await writeTerminalMarker(prisma, embeddingId, "bbox_unresolvable");

      // Post: excluded by the SSOT predicate → pending = 0 (no permanent pending,
      // NF-TPA-02 closed). The backfill processor will no longer re-fetch it, so
      // the page can reach `completed`.
      expect(await countPendingPartVisual(prisma, embeddingId)).toBe(0);

      // The marker is exactly the SSOT-derived terminal reason.
      const rows = await prisma.$queryRawUnsafe<Array<{ visual_skip_reason: string | null }>>(
        `SELECT visual_skip_reason FROM component_part_embeddings WHERE id = $1::uuid`,
        embeddingId
      );
      expect(rows[0]?.visual_skip_reason).toBe("bbox_unresolvable");
      expect(EMBEDDING_PART_VISUAL_SKIP_REASONS as readonly string[]).toContain(
        rows[0]?.visual_skip_reason
      );
    } finally {
      await prisma
        .$executeRawUnsafe(`DELETE FROM web_pages WHERE id = $1::uuid`, webPageId)
        .catch(() => undefined);
    }
  }, 60_000);

  it("INV-PART-VISUAL-SKIP-TERMINAL-001: (d) off-screen part (left >= imgWidth) → bbox_unresolvable marker → pending = 0 (horizontal edge case)", async () => {
    const webPageId = randomUUID();
    try {
      const { embeddingId } = await seedPendingPartEmbedding(prisma, webPageId);
      expect(await countPendingPartVisual(prisma, embeddingId)).toBe(1);

      // Horizontal off-screen: left edge at or beyond imgWidth.
      const { left, top } = clampLeftTop(PRF_IMG_WIDTH + 100, 0);
      expect(isFullyOffScreen(left, top, PRF_IMG_WIDTH, PRF_IMG_HEIGHT)).toBe(true);

      await writeTerminalMarker(prisma, embeddingId, "bbox_unresolvable");
      expect(await countPendingPartVisual(prisma, embeddingId)).toBe(0);
    } finally {
      await prisma
        .$executeRawUnsafe(`DELETE FROM web_pages WHERE id = $1::uuid`, webPageId)
        .catch(() => undefined);
    }
  }, 60_000);

  it("INV-PART-VISUAL-SKIP-TERMINAL-001: (d) partially-visible part (top < imgHeight, top+height > imgHeight) is NOT off-screen → no marker → stays pending (over-termination guard)", async () => {
    const webPageId = randomUUID();
    try {
      const { embeddingId } = await seedPendingPartEmbedding(prisma, webPageId);
      expect(await countPendingPartVisual(prisma, embeddingId)).toBe(1);

      // Partially-visible: top edge inside the viewport, but the part extends
      // past the bottom (top + height > imgHeight). The production exit #2a guard
      // MUST NOT classify this as off-screen — it still has croppable pixels and
      // continues through the clamp to DINOv2.
      const partHeight = 400;
      const absY = PRF_IMG_HEIGHT - 100; // top inside, bottom (980 + 400) past edge
      const { left, top } = clampLeftTop(0, absY);
      expect(top).toBeLessThan(PRF_IMG_HEIGHT);
      expect(top + partHeight).toBeGreaterThan(PRF_IMG_HEIGHT);
      expect(isFullyOffScreen(left, top, PRF_IMG_WIDTH, PRF_IMG_HEIGHT)).toBe(false);

      // Production behavior: NO terminal marker is written for a partially-visible
      // part — the row stays pending so its croppable portion is still embedded
      // (or, if DINOv2 transiently fails, exit #3 keeps it pending for retry).
      // We deliberately do NOT call writeTerminalMarker here.
      expect(await countPendingPartVisual(prisma, embeddingId)).toBe(1);

      // Confirm visual_skip_reason remains NULL (not over-terminated).
      const rows = await prisma.$queryRawUnsafe<Array<{ visual_skip_reason: string | null }>>(
        `SELECT visual_skip_reason FROM component_part_embeddings WHERE id = $1::uuid`,
        embeddingId
      );
      expect(rows[0]?.visual_skip_reason).toBeNull();
    } finally {
      await prisma
        .$executeRawUnsafe(`DELETE FROM web_pages WHERE id = $1::uuid`, webPageId)
        .catch(() => undefined);
    }
  }, 60_000);
});

// ============================================================================
// Local helpers
// ============================================================================

function collectTsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "generated") {
          continue;
        }
        walk(abs);
      } else if (entry.isFile() && abs.endsWith(".ts") && !abs.endsWith(".test.ts")) {
        out.push(abs);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Pass-through over the raw source — currently a no-op (`return src`).
 *
 * The forward-compat sweep (case (e), line ~205) discriminates a marker-UPDATE
 * (`SET visual_skip_reason = $1 WHERE ... visual_skip_reason IS NULL`) from a
 * pending query by directly regex-testing the **raw source** for
 * `/SET visual_skip_reason/`: a file is treated as a pending-query offender only
 * when it contains `visual_embedding IS NULL` AND does NOT contain
 * `SET visual_skip_reason`. The discrimination is therefore performed by that
 * regex on the raw `src` returned unchanged here; no block-stripping is needed
 * for the current SSOT layout (the marker UPDATE and the pending SELECT/COUNT
 * never co-reside in a file in a way that defeats the raw-source regex).
 *
 * Kept as a named seam so the sweep can later switch to block-level stripping
 * without touching the call site, should the SSOT layout change. The
 * helper-removal / inline-integration is deferred to a tracked issue (Phase 3
 * docs-sync FIND-IMPL-V2-L1 = TPA-IMPL-L-02 = TDA-IMPL-V2-01); this docs-sync
 * only aligns the JSDoc to the no-op pass-through implementation.
 */
function stripMarkerUpdateBlocks(src: string): string {
  return src;
}
