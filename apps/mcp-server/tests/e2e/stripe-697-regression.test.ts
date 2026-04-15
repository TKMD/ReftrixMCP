// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stripe 697 Parts Regression — End-to-End Test (v0.4.0 PR6)
 *
 * 背景 / Background:
 * Stripe.com を `page.analyze` した際、Part Extraction が 697 件の Part を返しても
 * Phase 5 同期フェーズで embedding が 0 件で完了するサイレント skip バグが
 * 発生していた。v0.4.0 の PR1-5 を経て本 PR6 で完全修正。本テストは回帰防止を
 * 目的とした end-to-end シナリオ。
 *
 * Background: When running `page.analyze` against Stripe.com, a silent-skip bug
 * produced 697 extracted Parts but 0 embeddings saved in Phase 5 synchronous
 * phase. Fixed through v0.4.0 PR1-5, finalized in this PR6. This test is a
 * regression guard.
 *
 * 実行条件 / Execution gating:
 * - CI 環境では Redis + worker 起動が重いため `describe.skipIf` で skip。
 * - ローカル検証時: `REFTRIX_RUN_STRIPE_E2E=1 pnpm vitest run stripe-697`
 *
 * - Skipped in CI via `describe.skipIf` because Redis + worker bootstrap is heavy.
 * - Local run: `REFTRIX_RUN_STRIPE_E2E=1 pnpm vitest run stripe-697`
 *
 * @module tests/e2e/stripe-697-regression
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { TEST_DATABASE_URL } from "./test-database-url";

const hasE2EEnv =
  process.env.REFTRIX_RUN_STRIPE_E2E === "1" || process.env.REFTRIX_RUN_STRIPE_E2E === "true";

const prisma = new PrismaClient({
  datasources: { db: { url: TEST_DATABASE_URL } },
  log: ["error"],
});

// Expected invariants / 期待される不変条件
const EXPECTED_MIN_PARTS = 100; // Threshold / sync phase cap
const RSS_KILL_THRESHOLD_BYTES = 3 * 1024 * 1024 * 1024; // 3GB — PR3 kill threshold
const BACKFILL_AWAIT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

describe.skipIf(!hasE2EEnv)("Stripe 697 Parts Regression (v0.4.0 PR6)", () => {
  let pageAnalyzeHandler: (input: unknown) => Promise<unknown>;
  let pageIdForTest: string | null = null;

  beforeAll(async () => {
    const module = await import("../../src/tools/page");
    pageAnalyzeHandler = module.pageAnalyzeHandler;
  });

  afterAll(async () => {
    if (pageIdForTest) {
      try {
        await prisma.webPage.delete({ where: { id: pageIdForTest } });
      } catch {
        // Best-effort cleanup only / クリーンアップは best-effort
      }
    }
    await prisma.$disconnect();
  });

  it(
    "analyzes stripe.com without silent-skip, enqueues backfill, and saves all Part embeddings",
    async () => {
      const startRss = process.memoryUsage().rss;
      const response = (await pageAnalyzeHandler({
        url: "https://stripe.com",
        options: {
          save_to_db: true,
          include_screenshot: false,
          include_html: false,
        },
      })) as {
        success: boolean;
        data?: {
          id: string;
          completedPhases: string[];
          failedPhases: string[];
          results?: {
            embedding?: {
              partEmbeddingsGenerated?: number;
              partVisualEmbeddingsGenerated?: number;
              skipReason?: string;
              backfillPending?: {
                partTextPending: number;
                partVisualPending: number;
                jobIds: string[];
                estimatedCompletionAt?: string;
              };
            };
          };
          backfill?: unknown;
        };
      };

      // =====================================================
      // Assertion 1: page.analyze が成功する / page.analyze succeeds
      // =====================================================
      expect(response.success, "page.analyze should succeed").toBe(true);
      expect(response.data, "response data present").toBeDefined();
      const data = response.data!;
      pageIdForTest = data.id;

      // =====================================================
      // Assertion 2: completedPhases に embedding が含まれる（サイレント skip なし）
      // Assertion 2: completedPhases includes embedding (no silent-skip)
      // =====================================================
      expect(data.completedPhases, "embedding must complete").toContain("embedding");
      expect(data.failedPhases, "embedding must NOT be in failedPhases").not.toContain("embedding");
      expect(data.results?.embedding?.skipReason, "no skipReason").toBeUndefined();

      // =====================================================
      // Assertion 3: 同期フェーズで先頭 100 件の Part text embedding が保存済み
      // Assertion 3: Sync phase processed the first 100 Part text embeddings
      // =====================================================
      const embedding = data.results?.embedding;
      expect(embedding, "embedding results present").toBeDefined();
      expect(
        embedding?.partEmbeddingsGenerated ?? 0,
        "partEmbeddingsGenerated should be >= EXPECTED_MIN_PARTS"
      ).toBeGreaterThanOrEqual(EXPECTED_MIN_PARTS);

      // =====================================================
      // Assertion 4: embeddingBackfillStatus = 'queued'
      // =====================================================
      const webPage = await prisma.webPage.findUnique({
        where: { id: data.id },
        select: {
          embeddingBackfillStatus: true,
          embeddingBackfillStartedAt: true,
        },
      });
      expect(webPage, "web_page row present").not.toBeNull();
      expect(webPage!.embeddingBackfillStatus, "backfill status = queued").toBe("queued");
      expect(
        webPage!.embeddingBackfillStartedAt,
        "embeddingBackfillStartedAt set (PR6 TPA #2)"
      ).not.toBeNull();

      // =====================================================
      // Assertion 5: MCP response に backfillPending が埋まっている
      // Assertion 5: MCP response includes backfillPending
      // =====================================================
      expect(embedding?.backfillPending, "backfillPending present").toBeDefined();
      const pending = embedding!.backfillPending!;
      expect(pending.partTextPending, "partTextPending > 0").toBeGreaterThan(0);
      expect(pending.jobIds.length, "jobIds non-empty").toBeGreaterThan(0);

      // =====================================================
      // Assertion 6: RSS delta が PR3 kill threshold (3GB) 未満
      // Assertion 6: RSS delta stays below PR3 kill threshold (3GB)
      // =====================================================
      const endRss = process.memoryUsage().rss;
      const rssDelta = endRss - startRss;
      expect(rssDelta, "RSS delta should stay below 3GB (PR3 kill threshold)").toBeLessThan(
        RSS_KILL_THRESHOLD_BYTES
      );

      // =====================================================
      // Assertion 7: Queue Worker が backfill を完了させる（ポーリング）
      // Assertion 7: Queue Worker processes the backfill to completion (polling)
      //
      // Redis + backfill worker が同プロセスで走っている前提。
      // タイムアウト内で status が completed に遷移することを確認する。
      // =====================================================
      const startPoll = Date.now();
      let finalStatus: string | null = null;
      while (Date.now() - startPoll < BACKFILL_AWAIT_TIMEOUT_MS) {
        const row = await prisma.webPage.findUnique({
          where: { id: data.id },
          select: { embeddingBackfillStatus: true },
        });
        if (
          row &&
          (row.embeddingBackfillStatus === "completed" || row.embeddingBackfillStatus === "failed")
        ) {
          finalStatus = row.embeddingBackfillStatus;
          break;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      expect(finalStatus, "backfill reaches completed").toBe("completed");

      // =====================================================
      // Assertion 8: 最終的に全 Part の text_embedding が保存されている
      // Assertion 8: All Parts ultimately have text_embedding saved
      // =====================================================
      const gapRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count FROM component_parts cp
         LEFT JOIN component_part_embeddings cpe ON cp.id = cpe.component_part_id
         WHERE cp.web_page_id = $1::uuid
           AND cp.pii_risk_level != 'high'
           AND (cpe.id IS NULL OR cpe.text_embedding IS NULL)`,
        data.id
      );
      const gap = Number(gapRows[0]?.count ?? 0);
      expect(gap, "no remaining text_embedding gaps").toBe(0);
    },
    BACKFILL_AWAIT_TIMEOUT_MS + 60_000
  );
});
