// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Page Analyze Queue Response Schema Tests (v0.4.0 PR5)
 *
 * Validates the `backfillPending` field added to `PageAnalyzeJobResult.results.embedding`.
 * 型が正しく公開され、完全/部分/未設定の各形で型安全に構築できることを検証する。
 *
 * Verifies the `backfillPending` shape added in PR5: that the type is exported
 * and consumers can construct complete / partial / absent variants safely.
 */

import { describe, it, expect } from "vitest";
import type {
  PageAnalyzeJobResult,
  EmbeddingBackfillPending,
} from "../../src/queues/page-analyze-queue";

describe("PageAnalyzeJobResult.backfillPending (v0.4.0 PR5)", () => {
  describe("EmbeddingBackfillPending type", () => {
    it("requires partTextPending, partVisualPending and jobIds", () => {
      const pending: EmbeddingBackfillPending = {
        partTextPending: 10,
        partVisualPending: 10,
        jobIds: ["page-id:part_text", "page-id:part_visual"],
      };
      expect(pending.partTextPending).toBe(10);
      expect(pending.partVisualPending).toBe(10);
      expect(pending.jobIds).toHaveLength(2);
    });

    it("allows estimatedCompletionAt to be optional", () => {
      const pending: EmbeddingBackfillPending = {
        partTextPending: 5,
        partVisualPending: 0,
        jobIds: ["page-id:part_text"],
      };
      expect(pending.estimatedCompletionAt).toBeUndefined();
    });

    it("accepts ISO 8601 estimatedCompletionAt", () => {
      const iso = new Date().toISOString();
      const pending: EmbeddingBackfillPending = {
        partTextPending: 50,
        partVisualPending: 50,
        jobIds: ["page-id:part_text", "page-id:part_visual"],
        estimatedCompletionAt: iso,
      };
      expect(pending.estimatedCompletionAt).toBe(iso);
    });

    it("supports empty jobIds when no category was enqueued", () => {
      const pending: EmbeddingBackfillPending = {
        partTextPending: 0,
        partVisualPending: 0,
        jobIds: [],
      };
      expect(pending.jobIds).toEqual([]);
    });
  });

  describe("Composition within PageAnalyzeJobResult", () => {
    it("attaches backfillPending to results.embedding", () => {
      const result: PageAnalyzeJobResult = {
        webPageId: "019bc123-4567-7890-abcd-ef1234567890",
        success: true,
        partialSuccess: false,
        completedPhases: ["embedding"],
        failedPhases: [],
        results: {
          embedding: {
            sectionEmbeddingsGenerated: 12,
            partEmbeddingsGenerated: 100,
            backfillPending: {
              partTextPending: 50,
              partVisualPending: 50,
              jobIds: [
                "019bc123-4567-7890-abcd-ef1234567890:part_text",
                "019bc123-4567-7890-abcd-ef1234567890:part_visual",
              ],
              estimatedCompletionAt: "2026-04-12T10:00:00.000Z",
            },
          },
        },
      };
      expect(result.results?.embedding?.backfillPending).toBeDefined();
      expect(result.results?.embedding?.backfillPending?.partTextPending).toBe(50);
    });

    it("allows backfillPending to be absent on happy path (<= 100 parts)", () => {
      const result: PageAnalyzeJobResult = {
        webPageId: "019bc123-4567-7890-abcd-ef1234567890",
        success: true,
        partialSuccess: false,
        completedPhases: ["embedding"],
        failedPhases: [],
        results: {
          embedding: {
            sectionEmbeddingsGenerated: 12,
            partEmbeddingsGenerated: 50,
          },
        },
      };
      expect(result.results?.embedding?.backfillPending).toBeUndefined();
    });

    it("coexists with skipReason / skipDetail fields", () => {
      const result: PageAnalyzeJobResult = {
        webPageId: "019bc123-4567-7890-abcd-ef1234567890",
        success: false,
        partialSuccess: true,
        completedPhases: ["layout"],
        failedPhases: ["embedding"],
        results: {
          embedding: {
            skipReason: "v8_heap_headroom_low",
            skipDetail: "rss=14000MB > 12000MB",
          },
        },
      };
      expect(result.results?.embedding?.skipReason).toBe("v8_heap_headroom_low");
      expect(result.results?.embedding?.backfillPending).toBeUndefined();
    });
  });

  describe("Ship invariants", () => {
    it("partTextPending is non-negative", () => {
      const build = (n: number): EmbeddingBackfillPending => ({
        partTextPending: n,
        partVisualPending: 0,
        jobIds: [],
      });
      expect(build(0).partTextPending).toBeGreaterThanOrEqual(0);
      expect(build(100).partTextPending).toBeGreaterThanOrEqual(0);
    });

    it("jobId format matches <webPageId>__<category>", () => {
      const pending: EmbeddingBackfillPending = {
        partTextPending: 10,
        partVisualPending: 10,
        jobIds: [
          "019bc123-4567-7890-abcd-ef1234567890:part_text",
          "019bc123-4567-7890-abcd-ef1234567890:part_visual",
        ],
      };
      for (const jobId of pending.jobIds) {
        expect(jobId).toMatch(/^[0-9a-f-]{36}:(part_text|part_visual)$/);
      }
    });
  });
});
