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
  const { partCount, preEmbedAll = true, webPageIdOverride } = options;

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
