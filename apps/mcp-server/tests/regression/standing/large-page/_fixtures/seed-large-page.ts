// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — large-page domain seeding helper
 * large-page domain テスト用シードヘルパー
 *
 * >100 ComponentParts を含む WebPage を seed する。各 ComponentPart には
 * `component_part_embeddings` row を事前作成し、**backfill 対象 0 件 (no-op)**
 * にすることで、Worker が実 ONNX 推論に突入せずに即時 `completed` に遷移
 * できるようにする。これにより standing regression は **Queue → Worker →
 * DB 終端状態遷移の契約レベル不変条件のみ**を検証する
 * (ADR-0016 § Existing Test Migration Mapping の責務分離原則と整合)。
 *
 * Seeds a WebPage with more than 100 ComponentParts, each already paired with
 * a pre-populated `component_part_embeddings` row so that backfill has
 * **zero pending targets (no-op)**. The Worker then transitions directly to
 * `completed` without invoking ONNX inference, letting the standing suite
 * verify the **contract-level terminal-state invariant** (Queue → Worker →
 * DB transition) per ADR-0016 § Existing Test Migration Mapping's
 * responsibility split.
 *
 * ADR-0016 § Fixture URL Policy: RFC 2606 reserved domain only.
 * ADR-0016 § Fixture UUID Policy: `crypto.randomUUID()` (v4).
 *
 * @module tests/regression/standing/large-page/_fixtures/seed-large-page
 */

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

/**
 * Deterministic L2-normalized 768-dim vector generator.
 *
 * ADR-0016 § Mock Strategy: "zero-vector は禁止"。本 helper は seeded
 * random ではなく固定 unit vector (`1 / sqrt(768)` を全要素) を返す。
 * 目的は **pgvector テーブルに 768-dim の non-zero vector を存在させること**
 * のみで、similarity 比較は一切行わない (no-op backfill 経路)。
 *
 * Returns a fixed L2-normalized 768-dim unit vector (each element =
 * 1/sqrt(768)). Purpose is only to populate a non-zero vector in the
 * pgvector column — no similarity comparison is performed in this suite.
 */
function buildDeterministicUnitVector(): string {
  const dim = 768;
  const value = 1 / Math.sqrt(dim);
  const parts = new Array<string>(dim);
  for (let i = 0; i < dim; i++) {
    parts[i] = value.toFixed(10);
  }
  return `[${parts.join(",")}]`;
}

/**
 * Seed options for {@link seedWebPageWithParts}.
 */
export interface SeedLargePageOptions {
  /**
   * Number of ComponentParts to create. Must be > 100 to satisfy the
   * INV-PAGE-QUEUE-001 precondition.
   */
  partCount: number;

  /**
   * When true, pre-populates `component_part_embeddings` rows so that the
   * backfill worker finds zero pending targets and transitions immediately to
   * `completed`. Use `false` to leave embeddings missing (slower path, not
   * used by the standing suite in M2).
   *
   * @default true
   */
  preEmbedAll?: boolean;

  /**
   * Override the generated WebPage.id (advanced; default randomUUID).
   */
  webPageIdOverride?: string;

  /**
   * Initial `web_pages.analysisStatus`. Defaults to `"completed"` — the
   * SSOT-correct precondition for the INV-PAGE-QUEUE-001 contract: a >100-parts
   * page whose page.analyze has FINISHED and dispatched async backfill. The
   * PR-BT-4 H-1 analysis-status guard (ADR-0018 Amendment 10 Decision 10.1)
   * bounded-re-enqueues backfill jobs while the page is still analyzing
   * (`pending`/`processing`); the backfill worker only legitimately processes a
   * page once analysis is terminal, so the fixture must model that state.
   * Variants that exercise the page-analyze failure path (001-c / 001-d) can
   * override to `"pending"` / `"failed"`.
   *
   * @default "completed"
   */
  analysisStatus?: string;
}

/**
 * Seed result.
 */
export interface SeedLargePageResult {
  webPageId: string;
  partCount: number;
  url: string;
}

/**
 * Seed a WebPage with >100 ComponentParts for INV-PAGE-QUEUE-001 tests.
 *
 * @param prisma - PrismaClient bound to the testcontainer database
 * @param options - Seeding options
 * @returns Seeded ids for the test body to reference
 */
export async function seedWebPageWithParts(
  prisma: PrismaClient,
  options: SeedLargePageOptions
): Promise<SeedLargePageResult> {
  const {
    partCount,
    preEmbedAll = true,
    webPageIdOverride,
    analysisStatus = "completed",
  } = options;

  if (!Number.isFinite(partCount) || partCount <= 100) {
    throw new Error(
      `[seed-large-page] partCount must be > 100 to satisfy INV-PAGE-QUEUE-001 precondition (got ${partCount})`
    );
  }

  const webPageId = webPageIdOverride ?? randomUUID();
  // ADR-0016 § Fixture URL Policy: RFC 2606 reserved domain. Suffix keeps URL unique across tests.
  const url = `https://example.com/large-page-test/${webPageId}`;

  // -----------------------------------------------------------------------
  // 1. WebPage — minimum required non-null columns (per schema.prisma).
  //    Use `sourceType = 'user_provided'` / `usageScope = 'inspiration_only'`
  //    per schema doc to avoid NOT NULL constraint failures.
  // -----------------------------------------------------------------------
  await prisma.webPage.create({
    data: {
      id: webPageId,
      url,
      title: "large-page standing regression fixture",
      sourceType: "user_provided",
      usageScope: "inspiration_only",
      // Explicit default: backfill status is irrelevant to seeding (Worker will transition it).
      embeddingBackfillStatus: "not_required",
      // PR-BT-4 H-1: model a page whose analysis has completed (default), so the
      // analysis-status guard lets the backfill worker process rather than
      // bounded-re-enqueue. Overridable via options.analysisStatus.
      analysisStatus,
    },
  });

  // -----------------------------------------------------------------------
  // 2. SectionPattern — ComponentPart has a required FK to SectionPattern
  //    (onDelete: Cascade). Create one minimum-viable section to anchor all
  //    seeded ComponentParts.
  // -----------------------------------------------------------------------
  const sectionPatternId = randomUUID();
  await prisma.sectionPattern.create({
    data: {
      id: sectionPatternId,
      webPageId,
      sectionType: "hero",
      positionIndex: 0,
      layoutInfo: { type: "hero" },
    },
  });

  // -----------------------------------------------------------------------
  // 3. ComponentParts — minimum-viable rows. `piiRiskLevel='low'` so the
  //    backfill scanner (which skips `piiRiskLevel != 'high'`) considers
  //    them eligible; pre-embedded state makes the scan return zero rows.
  //    `extractedAt` is required (no schema default).
  // -----------------------------------------------------------------------
  const extractedAt = new Date();
  const partIds: string[] = [];
  for (let i = 0; i < partCount; i++) {
    const partId = randomUUID();
    partIds.push(partId);
    await prisma.componentPart.create({
      data: {
        id: partId,
        webPageId,
        sectionPatternId,
        partType: "button",
        partSubtype: "primary",
        computedStyles: {},
        attributes: {},
        boundingBox: { x: 0, y: 0, width: 100, height: 40 },
        interactionInfo: {},
        piiRiskLevel: "low",
        extractedAt,
      },
    });
  }

  // -----------------------------------------------------------------------
  // 3. Pre-populate component_part_embeddings with a deterministic unit
  //    vector so that backfillPartTextForPage finds zero pending targets.
  //    Uses $executeRawUnsafe with parameterized values for the pgvector
  //    cast (pgvector::vector is not a Prisma-native type).
  // -----------------------------------------------------------------------
  if (preEmbedAll) {
    const vectorLiteral = buildDeterministicUnitVector();
    for (const partId of partIds) {
      const embeddingId = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO component_part_embeddings
           (id, component_part_id, text_embedding, visual_embedding,
            visual_model_version, text_model_version, embedding_timestamp,
            created_at, updated_at)
         VALUES (
           $1::uuid, $2::uuid, $3::vector, $4::vector,
           'mock-dinov2-vit-b14', 'mock-e5-base-multilingual', NOW(),
           NOW(), NOW()
         )`,
        embeddingId,
        partId,
        vectorLiteral,
        vectorLiteral
      );
    }
  }

  return { webPageId, partCount, url };
}

/**
 * Seed result for {@link seedPartialCompletionPage}.
 */
export interface SeedPartialCompletionResult {
  webPageId: string;
  /** Total ComponentParts created (`partCount`). */
  partCount: number;
  /** ComponentParts that received a `component_part_embeddings` row (embedded). */
  inlineEmbeddedCount: number;
  /** ComponentParts left WITHOUT an embedding (= residual pending). */
  pendingCount: number;
  url: string;
}

/**
 * PR-PART30CAP (ADR-0007 Amendment 2): seed a parts≤100 WebPage that models an
 * inline **partial-completion** — only the first `inlineEmbeddedCount` parts have
 * a `component_part_embeddings` row, the rest are left un-embedded (residual
 * pending). This reproduces the run3 stuck state where a C1 per-chunk RSS budget
 * break stops inline embedding at chunk 0 (= `EMBEDDING_CHUNK_SIZE` = 30 parts)
 * on a parts≤100 page, leaving residual parts that the old threshold gate
 * (parts>100) never enqueued → permanent `in_progress`.
 *
 * **Why a separate fixture (not `seedWebPageWithParts`)** (TPA-M-03 / TDA-M-02):
 * `seedWebPageWithParts` throws when `partCount <= 100` and offers only an
 * all-or-nothing `preEmbedAll: boolean`. The parts≤100 partial-completion gap
 * was therefore **structurally untestable** with the existing helper — the exact
 * reason the gap was masked. This fixture parameterizes `partCount` and
 * `inlineEmbeddedCount` independently so the parts≤100 path (e.g. 81-part page,
 * 30 inline-embedded, 51 residual pending) is exercised by a CI-failing test.
 *
 * **RSS-independent determinism** (TDA-M-01): partial-completion is reproduced by
 * DB-state injection (only `inlineEmbeddedCount` parts get an embedding row), NOT
 * by triggering a real `rssMb()` budget break. No physical-memory dependency →
 * no flaky behaviour (testing-requirements.md §5 anti-pattern avoidance).
 *
 * @param prisma - PrismaClient bound to the testcontainer database
 * @param options.partCount - total ComponentParts (≥1; intended ≤100 for the gap)
 * @param options.inlineEmbeddedCount - how many parts receive an embedding row
 *   (0 ≤ inlineEmbeddedCount ≤ partCount; the remainder are residual pending)
 * @param options.analysisStatus - initial `web_pages.analysisStatus` (default `"completed"`)
 * @param options.embeddingBackfillStatus - initial backfill status (default `"in_progress"`,
 *   modeling the stuck state observed in run3)
 * @returns seeded ids + the residual `pendingCount`
 */
export async function seedPartialCompletionPage(
  prisma: PrismaClient,
  options: {
    partCount: number;
    inlineEmbeddedCount: number;
    analysisStatus?: string;
    embeddingBackfillStatus?: string;
  }
): Promise<SeedPartialCompletionResult> {
  const {
    partCount,
    inlineEmbeddedCount,
    analysisStatus = "completed",
    embeddingBackfillStatus = "in_progress",
  } = options;

  // Validate the parameterization (deterministic precondition, no RSS dependency).
  if (!Number.isFinite(partCount) || partCount < 1) {
    throw new Error(`[seed-large-page] partCount must be a finite integer ≥ 1 (got ${partCount})`);
  }
  if (
    !Number.isFinite(inlineEmbeddedCount) ||
    inlineEmbeddedCount < 0 ||
    inlineEmbeddedCount > partCount
  ) {
    throw new Error(
      `[seed-large-page] inlineEmbeddedCount must satisfy 0 ≤ inlineEmbeddedCount ≤ partCount ` +
        `(got inlineEmbeddedCount=${inlineEmbeddedCount}, partCount=${partCount})`
    );
  }

  const webPageId = randomUUID();
  // ADR-0016 § Fixture URL Policy: RFC 2606 reserved domain. Suffix keeps URL unique.
  const url = `https://example.com/partial-completion-test/${webPageId}`;

  await prisma.webPage.create({
    data: {
      id: webPageId,
      url,
      title: "partial-completion standing regression fixture (PR-PART30CAP)",
      sourceType: "user_provided",
      usageScope: "inspiration_only",
      embeddingBackfillStatus,
      analysisStatus,
    },
  });

  const sectionPatternId = randomUUID();
  await prisma.sectionPattern.create({
    data: {
      id: sectionPatternId,
      webPageId,
      sectionType: "hero",
      positionIndex: 0,
      layoutInfo: { type: "hero" },
    },
  });

  const extractedAt = new Date();
  const partIds: string[] = [];
  for (let i = 0; i < partCount; i++) {
    const partId = randomUUID();
    partIds.push(partId);
    await prisma.componentPart.create({
      data: {
        id: partId,
        webPageId,
        sectionPatternId,
        partType: "button",
        partSubtype: "primary",
        computedStyles: {},
        attributes: {},
        boundingBox: { x: 0, y: 0, width: 100, height: 40 },
        interactionInfo: {},
        // piiRiskLevel='low' so the part_text pending scanner
        // (WHERE piiRiskLevel != 'high' AND embedding IS NULL) counts the
        // un-embedded residuals.
        piiRiskLevel: "low",
        extractedAt,
      },
    });
  }

  // Inline-embed only the first `inlineEmbeddedCount` parts (the chunk-0 head).
  // The remaining (partCount - inlineEmbeddedCount) parts are the residual that
  // the dual-trigger must enqueue → backfill must drain → page must complete.
  const vectorLiteral = buildDeterministicUnitVector();
  for (let i = 0; i < inlineEmbeddedCount; i++) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO component_part_embeddings
         (id, component_part_id, text_embedding, visual_embedding,
          visual_model_version, text_model_version, embedding_timestamp,
          created_at, updated_at)
       VALUES (
         $1::uuid, $2::uuid, $3::vector, $4::vector,
         'mock-dinov2-vit-b14', 'mock-e5-base-multilingual', NOW(),
         NOW(), NOW()
       )`,
      randomUUID(),
      partIds[i],
      vectorLiteral,
      vectorLiteral
    );
  }

  return {
    webPageId,
    partCount,
    inlineEmbeddedCount,
    pendingCount: partCount - inlineEmbeddedCount,
    url,
  };
}

/**
 * PR-PART30CAP: resolve the residual (un-embedded) ComponentParts of a page by
 * inserting `component_part_embeddings` rows for every part that still lacks one.
 * Simulates the now-enqueued part_text/part_visual backfill draining the residual
 * (no-fake-success: the actual fix path, not a status overwrite).
 *
 * @param prisma - PrismaClient
 * @param webPageId - parent page id
 * @returns number of residual parts embedded by this call
 */
export async function resolvePartTextResidual(
  prisma: PrismaClient,
  webPageId: string
): Promise<number> {
  const pendingParts = await prisma.componentPart.findMany({
    where: { webPageId, piiRiskLevel: { not: "high" }, embedding: { is: null } },
    select: { id: true },
  });
  const vectorLiteral = buildDeterministicUnitVector();
  for (const part of pendingParts) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO component_part_embeddings
         (id, component_part_id, text_embedding, visual_embedding,
          visual_model_version, text_model_version, embedding_timestamp,
          created_at, updated_at)
       VALUES (
         $1::uuid, $2::uuid, $3::vector, $4::vector,
         'mock-dinov2-vit-b14', 'mock-e5-base-multilingual', NOW(),
         NOW(), NOW()
       )`,
      randomUUID(),
      part.id,
      vectorLiteral,
      vectorLiteral
    );
  }
  return pendingParts.length;
}

/**
 * Seed a minimal WebPage (no parts) for the gate-less-category backfill
 * completeness invariant (INV-BACKFILL-TERMINAL-COMPLETED-007 Block B/C).
 *
 * PR-BT-1 (系統A): The happy-path enqueue gap caused motion/bg/js/responsive
 * (the 4 screenshot-free, gate-less categories) to never be enqueued, leaving
 * their pending counts permanently > 0 and mis-pinning the page to `failed`
 * via the reconciliation cron. This fixture seeds a small page so the
 * **parity-gate level** behaviour (pending → completed) can be exercised
 * directly against the live testcontainer DB. No ComponentParts are required
 * — the INV-007 Block B/C contract surface is the 7-category parity, not the
 * 100-part threshold (that is INV-PAGE-QUEUE-001's surface).
 *
 * @param prisma - PrismaClient bound to the testcontainer database
 * @param options.embeddingBackfillStatus - initial status (default `not_required`)
 * @returns seeded `webPageId` + `url`
 */
export async function seedMinimalWebPage(
  prisma: PrismaClient,
  options: { embeddingBackfillStatus?: string } = {}
): Promise<{ webPageId: string; url: string }> {
  const webPageId = randomUUID();
  const url = `https://example.com/backfill-terminal-test/${webPageId}`;
  await prisma.webPage.create({
    data: {
      id: webPageId,
      url,
      title: "backfill-terminal standing regression fixture",
      sourceType: "user_provided",
      usageScope: "inspiration_only",
      embeddingBackfillStatus: options.embeddingBackfillStatus ?? "not_required",
    },
  });
  return { webPageId, url };
}

/**
 * Seed a single `motion_patterns` row for `webPageId`, optionally WITH a
 * corresponding `motion_embeddings` row.
 *
 * `collectCategoryPendingSnapshot` counts motion as
 * `motion_patterns WHERE embedding IS NULL` (i.e. patterns lacking a
 * `motion_embeddings` row). A pattern WITHOUT an embedding is a motion
 * residual (pending > 0); WITH an embedding it is resolved (pending = 0).
 *
 * @param prisma - PrismaClient
 * @param webPageId - parent page id
 * @param options.withEmbedding - when true, also insert a motion_embeddings row
 */
export async function seedMotionPattern(
  prisma: PrismaClient,
  webPageId: string,
  options: { withEmbedding: boolean }
): Promise<{ motionPatternId: string }> {
  const motionPatternId = randomUUID();
  await prisma.motionPattern.create({
    data: {
      id: motionPatternId,
      webPageId,
      name: "fixture-motion",
      type: "css_animation",
      category: "entrance",
      triggerType: "scroll",
      triggerConfig: {},
      animation: { duration: 600, delay: 0 },
      properties: [],
      implementation: { css: "" },
      accessibility: {},
    },
  });

  if (options.withEmbedding) {
    const value = 1 / Math.sqrt(768);
    const vectorLiteral = `[${new Array<string>(768).fill(value.toFixed(10)).join(",")}]`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO motion_embeddings
         (id, motion_pattern_id, embedding, model_version, embedding_timestamp,
          created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::vector, 'mock-e5-base-multilingual', NOW(), NOW(), NOW())`,
      randomUUID(),
      motionPatternId,
      vectorLiteral
    );
  }

  return { motionPatternId };
}

/**
 * Seed a single `section_patterns` + `section_embeddings` row for `webPageId`.
 *
 * PR-BT-2 (系統B): INV-BACKFILL-TERMINAL-COMPLETED-007 Block D/E need section
 * rows in the "both-NULL pending" state — `text_embedding IS NOT NULL AND
 * vision_embedding IS NULL` (the section_visual pending condition). The
 * `layoutInfo.position.{startY,height}` drives the `sectionPositionMap` used by
 * `processSingleSectionVisualEmbedding` (a startY >= imgHeight makes the section
 * out-of-range / uncroppable on the backfill path).
 *
 * Seeds one SectionPattern + section_embeddings row with a text_embedding
 * present and vision_embedding NULL, optionally pre-setting vision_skip_reason.
 *
 * @param prisma - PrismaClient bound to the testcontainer database
 * @param webPageId - parent page id
 * @param options.sectionType - SectionPattern.sectionType (default "feature")
 * @param options.positionIndex - SectionPattern.positionIndex (unique per page)
 * @param options.startY - layoutInfo.position.startY (default 0)
 * @param options.height - layoutInfo.position.height (default 400)
 * @param options.textRepresentation - text_representation source (non-empty)
 * @param options.visionEmbedding - optional 768-dim vector literal to set vision
 * @param options.visionSkipReason - optional terminal-skip marker to pre-set
 * @returns seeded section ids
 */
export async function seedSectionEmbedding(
  prisma: PrismaClient,
  webPageId: string,
  options: {
    sectionType?: string;
    positionIndex: number;
    startY?: number;
    height?: number;
    textRepresentation?: string;
    visionEmbedding?: string | null;
    visionSkipReason?: string | null;
  }
): Promise<{ sectionPatternId: string; sectionEmbeddingId: string }> {
  const {
    sectionType = "feature",
    positionIndex,
    startY = 0,
    height = 400,
    textRepresentation = "section fixture text representation",
    visionEmbedding = null,
    visionSkipReason = null,
  } = options;

  const sectionPatternId = randomUUID();
  await prisma.sectionPattern.create({
    data: {
      id: sectionPatternId,
      webPageId,
      sectionType,
      positionIndex,
      layoutInfo: { type: sectionType, position: { startY, height } },
    },
  });

  // section_embeddings: text_embedding present, vision_embedding NULL (the
  // both-NULL pending state). pgvector columns require raw SQL (Unsupported type).
  // Insert the base both-NULL row first (fixed 4-param shape), then apply the
  // optional vision_embedding / vision_skip_reason via separate UPDATEs — this
  // keeps the parameter binding deterministic (no dynamic $N computation).
  const sectionEmbeddingId = randomUUID();
  const textVector = buildDeterministicUnitVector();
  // `model_version` is NOT NULL with no DB default (mirrors the mock model
  // version used by the part-embedding fixtures). `embedding_timestamp` /
  // `created_at` have CURRENT_TIMESTAMP defaults; `updated_at` is NOT NULL with
  // no default → set explicitly via NOW().
  await prisma.$executeRawUnsafe(
    `INSERT INTO section_embeddings
       (id, section_pattern_id, text_embedding, model_version, text_representation,
        embedding_timestamp, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::vector, 'mock-e5-base-multilingual', $4,
        NOW(), NOW(), NOW())`,
    sectionEmbeddingId,
    sectionPatternId,
    textVector,
    textRepresentation
  );

  if (visionEmbedding) {
    await prisma.$executeRawUnsafe(
      `UPDATE section_embeddings SET vision_embedding = $1::vector WHERE id = $2::uuid`,
      visionEmbedding,
      sectionEmbeddingId
    );
  }
  if (visionSkipReason) {
    await prisma.$executeRawUnsafe(
      `UPDATE section_embeddings SET vision_skip_reason = $1 WHERE id = $2::uuid`,
      visionSkipReason,
      sectionEmbeddingId
    );
  }

  return { sectionPatternId, sectionEmbeddingId };
}

/**
 * Read a section_embeddings row's vision_embedding-present flag and
 * vision_skip_reason marker (PR-BT-2 Block D/E assertions).
 *
 * @returns `{ hasVision, visionSkipReason }`
 */
export async function readSectionVisionState(
  prisma: PrismaClient,
  sectionEmbeddingId: string
): Promise<{ hasVision: boolean; visionSkipReason: string | null }> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ has_vision: boolean; vision_skip_reason: string | null }>
  >(
    `SELECT (vision_embedding IS NOT NULL) AS has_vision, vision_skip_reason
       FROM section_embeddings WHERE id = $1::uuid`,
    sectionEmbeddingId
  );
  const row = rows[0];
  return {
    hasVision: row?.has_vision ?? false,
    visionSkipReason: row?.vision_skip_reason ?? null,
  };
}

/**
 * Best-effort cleanup of a seeded fixture. Cascades remove ComponentParts
 * and component_part_embeddings via Prisma `onDelete: Cascade`.
 *
 * Cleans up a seeded fixture. ComponentParts and component_part_embeddings
 * are removed via Prisma `onDelete: Cascade`.
 */
export async function cleanupSeededWebPage(prisma: PrismaClient, webPageId: string): Promise<void> {
  try {
    await prisma.webPage.delete({ where: { id: webPageId } });
  } catch {
    // swallow — afterAll best-effort
  }
}
