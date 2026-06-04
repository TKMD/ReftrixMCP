// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PageAnalyzeWorker — Counter Reconciliation Tests (v0.4.0 PR5)
 *
 * Verifies the 9-category Post-Phase 5 Counter Reconciliation logic and the
 * `backfillPending` MCP response field added in PR5.
 *
 * v0.4.0 PR5 で 4 カテゴリから 9 カテゴリへ拡張した Counter Reconciliation と
 * MCP response の `backfillPending` フィールドをソースコード構造で検証する。
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("PageAnalyzeWorker Counter Reconciliation (v0.4.0 PR5)", () => {
  const workerPath = path.resolve(__dirname, "../../src/workers/page-analyze-worker.ts");
  let workerSource: string;

  beforeAll(() => {
    workerSource = fs.readFileSync(workerPath, "utf8");
  });

  describe("9-category reconciliation", () => {
    it("reconciles sectionEmbeddingsGenerated against DB", () => {
      expect(workerSource).toContain('reconcile("sectionEmbeddingsGenerated"');
    });

    it("reconciles sectionVisualEmbeddingsGenerated against DB", () => {
      expect(workerSource).toContain('reconcile("sectionVisualEmbeddingsGenerated"');
    });

    it("reconciles partEmbeddingsGenerated (part_text) against DB", () => {
      expect(workerSource).toContain('reconcile("partEmbeddingsGenerated"');
    });

    it("reconciles partVisualEmbeddingsGenerated against DB (PR5 new)", () => {
      expect(workerSource).toContain('reconcile("partVisualEmbeddingsGenerated"');
    });

    it("reconciles motionEmbeddingsGenerated against DB", () => {
      expect(workerSource).toContain('reconcile("motionEmbeddingsGenerated"');
    });

    it("reconciles backgroundDesignEmbeddingsGenerated against DB", () => {
      expect(workerSource).toContain('reconcile("backgroundDesignEmbeddingsGenerated"');
    });

    it("reconciles jsAnimationEmbeddingsGenerated against DB (PR5 new)", () => {
      expect(workerSource).toContain('reconcile("jsAnimationEmbeddingsGenerated"');
    });

    it("reconciles responsiveEmbeddingsGenerated against DB (PR5 new)", () => {
      expect(workerSource).toContain('reconcile("responsiveEmbeddingsGenerated"');
    });
  });

  describe("Non-null embedding counting (PR6 TDA TD-1: extracted to countNonNullVector util)", () => {
    // v0.4.0 PR6 TDA TD-1: ローカル `queryCountNonNull` は
    // `utils/prisma-raw-count.ts` の `countNonNullVector` に抽出された。
    // worker 本体はこの util を 4 ケース（section text/vision、part text/visual）
    // 呼ぶだけになるため、呼び出し側のテーブル/カラム指定をアサートする。
    //
    // v0.4.0 PR6 TDA TD-1: Extracted to `countNonNullVector`. Worker invokes
    // the util for 4 cases (section text/vision, part text/visual); we assert
    // the call-site table/column arguments.
    it("imports countNonNullVector from extracted util (PR6 TDA TD-1)", () => {
      expect(workerSource).toMatch(
        /import \{[\s\S]*countNonNullVector[\s\S]*\} from "\.\.\/utils\/prisma-raw-count"/
      );
    });

    it("counts section text_embedding via util", () => {
      expect(workerSource).toMatch(/table:\s*"section_embeddings"/);
      expect(workerSource).toMatch(/column:\s*"text_embedding"/);
    });

    it("counts section vision_embedding via util", () => {
      expect(workerSource).toMatch(/column:\s*"vision_embedding"/);
    });

    it("counts part text_embedding via util", () => {
      expect(workerSource).toMatch(/table:\s*"component_part_embeddings"/);
    });

    it("counts part visual_embedding via util", () => {
      expect(workerSource).toMatch(/column:\s*"visual_embedding"/);
    });

    it("joins through section_patterns for webPage scoping", () => {
      expect(workerSource).toContain("JOIN section_patterns sp ON");
    });

    it("joins through component_parts for webPage scoping", () => {
      expect(workerSource).toContain("JOIN component_parts cp ON");
    });
  });

  describe("backfillPending MCP response field", () => {
    // v0.4.0 PR6 TDA TD-3: backfillPending 構築ロジックは
    // `services/backfill-pending.builder.ts` の pure function に抽出された。
    // worker 本体は `buildBackfillPending()` を呼ぶだけになるため、抽出後の
    // 呼び出し側 API をアサートする。
    //
    // v0.4.0 PR6 TDA TD-3: backfillPending construction logic was extracted to
    // a pure function in `services/backfill-pending.builder.ts`. The worker
    // now only invokes `buildBackfillPending()`, so we assert the call-site API.
    it("imports buildBackfillPending from extracted builder (PR6 TDA TD-3)", () => {
      expect(workerSource).toMatch(
        /import \{[\s\S]*buildBackfillPending[\s\S]*\} from "\.\.\/services\/backfill-pending\.builder"/
      );
    });

    it("invokes buildBackfillPending with enqueuedTextCategory/enqueuedVisualCategory", () => {
      expect(workerSource).toContain("buildBackfillPending({");
      expect(workerSource).toContain("enqueuedTextCategory");
      expect(workerSource).toContain("enqueuedVisualCategory");
    });

    it("passes partsSaved/threshold/avgMsPerItem to the builder", () => {
      expect(workerSource).toMatch(/partsSaved:\s*partsSavedCountForPhase5/);
      expect(workerSource).toMatch(/threshold:\s*PART_SYNC_THRESHOLD/);
      expect(workerSource).toMatch(/avgMsPerItem:\s*BACKFILL_AVG_MS_PER_ITEM/);
    });

    it("exposes BACKFILL_AVG_MS_PER_ITEM via EMBEDDING_BACKFILL_AVG_MS_PER_ITEM env var", () => {
      expect(workerSource).toContain('process.env["EMBEDDING_BACKFILL_AVG_MS_PER_ITEM"]');
    });

    it("clamps BACKFILL_AVG_MS_PER_ITEM to [100, 60000]", () => {
      expect(workerSource).toMatch(/min:\s*100/);
      expect(workerSource).toMatch(/max:\s*60000/);
    });

    it("sets backfillPending only when backfill jobs were actually enqueued", () => {
      // enqueued.length > 0 check must still guard backfillPending population.
      // PR-C2 (Layer 2, ADR-0007 Amendment 3): the sync_overflow enqueue body
      // was relocated into the `runSyncOverflowEnqueue` closure (executed after
      // markComplete via `enqueueBackfillAfterMarkComplete`); the former
      // `backfillEnqueuedCategories` local is now `enqueuedCategories` inside
      // that closure. The contract (length > 0 guards backfillPending) is
      // unchanged.
      expect(workerSource).toContain("enqueuedCategories.length > 0");
    });

    it("assigns backfillPending onto results.embedding when builder returns non-null", () => {
      expect(workerSource).toContain("backfillResults.embedding.backfillPending");
      // PR6 TDA TD-3: builder may return null; guard must exist.
      expect(workerSource).toMatch(/if\s*\(\s*backfillPending\s*\)/);
    });
  });

  describe("IPC-race compensation still aggregates all 9 counters", () => {
    it("dbTotal sums all 8 counter buckets", () => {
      // Note: text/visual are merged into the overall dbTotal; 9 categories
      // cover 8 non-null buckets (part_text/visual split into two counts).
      expect(workerSource).toContain("sectionEmbDbCount +");
      expect(workerSource).toContain("sectionVisualEmbDbCount +");
      expect(workerSource).toContain("partTextEmbDbCount +");
      expect(workerSource).toContain("partVisualEmbDbCount +");
      expect(workerSource).toContain("motionEmbDbCount +");
      expect(workerSource).toContain("bgEmbDbCount +");
      expect(workerSource).toContain("jsAnimationEmbDbCount +");
      expect(workerSource).toContain("responsiveEmbDbCount");
    });
  });
});
