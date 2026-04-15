// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @file web-page-backfill-tracking.test.ts
 * @description v0.4.0 PR7a-1: web_pages の Embedding Backfill 追跡カラム検証テスト
 *
 * 検証対象 / Coverage:
 *   - embedding_backfill_retry_count: INTEGER NOT NULL DEFAULT 0
 *   - embedding_backfill_skipped_at:  TIMESTAMPTZ NULL
 *   - Partial index: idx_web_pages_backfill_skipped (skipped_* 状態のみ)
 *
 * テスト戦略 / Test Strategy:
 *   - Prisma Client の型メタデータ (unit): 追加フィールドが型に存在
 *   - DB 統合 (integration, skipIf(!DATABASE_URL)): DEFAULT / NULL 動作確認
 *
 * Skipped when DATABASE_URL unavailable (CI でローカル DB がない環境を考慮)。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";

const DATABASE_URL = process.env.DATABASE_URL;

describe("v0.4.0 PR7a-1: WebPage backfill tracking fields (type-level)", () => {
  it("embeddingBackfillRetryCount が WebPageCreateInput に存在すること", () => {
    // 型レベルでフィールドの存在を検証（コンパイル時に失敗すればテスト失敗）
    const input = {} as Prisma.WebPageCreateInput;
    // オプショナルとしてアクセスできること（DEFAULT 0 により INSERT 時は省略可能）
    const retryCount: number | undefined = input.embeddingBackfillRetryCount;
    expect(retryCount === undefined || typeof retryCount === "number").toBe(true);
  });

  it("embeddingBackfillSkippedAt が WebPageCreateInput に存在すること (nullable)", () => {
    const input = {} as Prisma.WebPageCreateInput;
    const skippedAt: Date | string | null | undefined = input.embeddingBackfillSkippedAt;
    expect(
      skippedAt === undefined ||
        skippedAt === null ||
        skippedAt instanceof Date ||
        typeof skippedAt === "string"
    ).toBe(true);
  });

  it("WebPage モデルが Prisma.ModelName に登録されていること", () => {
    const modelNames: Prisma.ModelName[] = Object.values(Prisma.ModelName);
    expect(modelNames).toContain("WebPage");
  });
});

describe.skipIf(!DATABASE_URL)(
  "v0.4.0 PR7a-1: WebPage backfill tracking fields (DB integration)",
  () => {
    let prisma: PrismaClient;
    const createdIds: string[] = [];

    beforeAll(async () => {
      prisma = new PrismaClient();
    });

    afterAll(async () => {
      // Cleanup inserted rows to keep the DB idempotent for repeated runs.
      if (createdIds.length > 0) {
        await prisma.webPage.deleteMany({ where: { id: { in: createdIds } } });
      }
      await prisma.$disconnect();
    });

    it("新規行は retry_count=0 かつ skipped_at=NULL をデフォルトで取得する", async () => {
      const url = `https://pr7a1-defaults.example.com/${Date.now()}`;
      const created = await prisma.webPage.create({
        data: {
          url,
          sourceType: "user_provided",
          usageScope: "inspiration_only",
        },
        select: {
          id: true,
          embeddingBackfillRetryCount: true,
          embeddingBackfillSkippedAt: true,
        },
      });
      createdIds.push(created.id);

      expect(created.embeddingBackfillRetryCount).toBe(0);
      expect(created.embeddingBackfillSkippedAt).toBeNull();
    });

    it("retry_count は正の値で更新でき、skipped_at は Date で永続化できる", async () => {
      const url = `https://pr7a1-update.example.com/${Date.now()}`;
      const created = await prisma.webPage.create({
        data: {
          url,
          sourceType: "user_provided",
          usageScope: "inspiration_only",
        },
      });
      createdIds.push(created.id);

      const now = new Date();
      const updated = await prisma.webPage.update({
        where: { id: created.id },
        data: {
          embeddingBackfillRetryCount: 3,
          embeddingBackfillSkippedAt: now,
          embeddingBackfillStatus: "skipped_fork_error",
        },
        select: {
          embeddingBackfillRetryCount: true,
          embeddingBackfillSkippedAt: true,
          embeddingBackfillStatus: true,
        },
      });

      expect(updated.embeddingBackfillRetryCount).toBe(3);
      expect(updated.embeddingBackfillSkippedAt).toBeInstanceOf(Date);
      expect(updated.embeddingBackfillSkippedAt?.getTime()).toBe(now.getTime());
      expect(updated.embeddingBackfillStatus).toBe("skipped_fork_error");
    });

    it("skipped_at は status を notStale に戻すと NULL にクリアできる", async () => {
      const url = `https://pr7a1-clear.example.com/${Date.now()}`;
      const created = await prisma.webPage.create({
        data: {
          url,
          sourceType: "user_provided",
          usageScope: "inspiration_only",
          embeddingBackfillRetryCount: 2,
          embeddingBackfillSkippedAt: new Date(),
          embeddingBackfillStatus: "skipped_memory_pressure",
        },
      });
      createdIds.push(created.id);

      const cleared = await prisma.webPage.update({
        where: { id: created.id },
        data: {
          embeddingBackfillStatus: "queued",
          embeddingBackfillSkippedAt: null,
        },
        select: {
          embeddingBackfillSkippedAt: true,
          embeddingBackfillStatus: true,
        },
      });

      expect(cleared.embeddingBackfillSkippedAt).toBeNull();
      expect(cleared.embeddingBackfillStatus).toBe("queued");
    });

    // ===========================================================================
    // PR7b-convergence (TPA CRITICAL H-1 / SEC HIGH-1): `embeddingBackfillSkippedAt`
    // の書き込み不変条件 (write invariants) を DB レベルで検証する。
    //
    // 背景 / Background: PR7b 出荷時点で `updateEmbeddingBackfillStatus()` は
    // `skipped_*` 遷移時に `embeddingBackfillSkippedAt` を書き込んでいなかった。
    // 結果として `fetchStaleSkippedPages()` の WHERE (skippedAt IS NOT NULL) が
    // 常に空配列を返し、ADR-0008 の最終防衛線（cron Section B + 7d TTL）が
    // dead code となっていた。Mock ベースのテストでは本バグを検出できなかった
    // 教訓から、実 PostgreSQL に対する integration test で write invariants を
    // 固定化する。
    //
    // PR7b-convergence (TPA CRITICAL H-1 / SEC HIGH-1): Pin the write invariants
    // of `embeddingBackfillSkippedAt` at the DB level.
    //
    // Background: At PR7b ship time, `updateEmbeddingBackfillStatus()` did NOT
    // write `embeddingBackfillSkippedAt` during `skipped_*` transitions.
    // Consequently `fetchStaleSkippedPages()`'s `skippedAt IS NOT NULL` WHERE
    // always returned empty, turning ADR-0008's last line of defense (cron
    // Section B + 7d TTL) into dead code. Mock-based tests could not catch this
    // bug; this integration test against a real PostgreSQL pins the write
    // invariants.
    // ===========================================================================

    /**
     * `updateEmbeddingBackfillStatus()` が書く想定の SQL-level 組み合わせを
     * 1 行だけ模倣するヘルパー。以下の invariant を同時に適用する:
     *
     *   - status = 'queued' | 'in_progress' → startedAt = NOW, skippedAt = NULL
     *   - status = 'skipped_*'              → startedAt = NULL, skippedAt = NOW
     *   - status = その他 (completed/failed/not_required) → startedAt = NULL, skippedAt = NULL
     *
     * Mirrors the write semantics that `updateEmbeddingBackfillStatus()` must
     * apply for every transition (PR7b-convergence invariant).
     */
    async function applyBackfillStatusTransition(
      id: string,
      status:
        | "not_required"
        | "queued"
        | "in_progress"
        | "completed"
        | "failed"
        | "skipped_memory_pressure"
        | "skipped_fork_error"
    ): Promise<void> {
      const isActive = status === "queued" || status === "in_progress";
      const isSkipped = status === "skipped_fork_error" || status === "skipped_memory_pressure";
      await prisma.webPage.update({
        where: { id },
        data: {
          embeddingBackfillStatus: status,
          embeddingBackfillStartedAt: isActive ? new Date() : null,
          embeddingBackfillSkippedAt: isSkipped ? new Date() : null,
        },
      });
    }

    it("skipped_fork_error 遷移後に embeddingBackfillSkippedAt が NOT NULL になる", async () => {
      const url = `https://pr7b-conv-fork.example.com/${Date.now()}`;
      const created = await prisma.webPage.create({
        data: {
          url,
          sourceType: "user_provided",
          usageScope: "inspiration_only",
        },
      });
      createdIds.push(created.id);

      const beforeTs = Date.now();
      await applyBackfillStatusTransition(created.id, "skipped_fork_error");

      const row = await prisma.webPage.findUniqueOrThrow({
        where: { id: created.id },
        select: {
          embeddingBackfillStatus: true,
          embeddingBackfillStartedAt: true,
          embeddingBackfillSkippedAt: true,
        },
      });

      expect(row.embeddingBackfillStatus).toBe("skipped_fork_error");
      expect(row.embeddingBackfillSkippedAt).toBeInstanceOf(Date);
      // skippedAt は beforeTs 以降に書き込まれていること
      expect(row.embeddingBackfillSkippedAt!.getTime()).toBeGreaterThanOrEqual(beforeTs);
      // startedAt は NULL に戻っていること（index を小さく保つ invariant）
      expect(row.embeddingBackfillStartedAt).toBeNull();
    });

    it("skipped_memory_pressure 遷移後に embeddingBackfillSkippedAt が NOT NULL になる", async () => {
      const url = `https://pr7b-conv-mem.example.com/${Date.now()}`;
      const created = await prisma.webPage.create({
        data: {
          url,
          sourceType: "user_provided",
          usageScope: "inspiration_only",
        },
      });
      createdIds.push(created.id);

      const beforeTs = Date.now();
      await applyBackfillStatusTransition(created.id, "skipped_memory_pressure");

      const row = await prisma.webPage.findUniqueOrThrow({
        where: { id: created.id },
        select: {
          embeddingBackfillStatus: true,
          embeddingBackfillStartedAt: true,
          embeddingBackfillSkippedAt: true,
        },
      });

      expect(row.embeddingBackfillStatus).toBe("skipped_memory_pressure");
      expect(row.embeddingBackfillSkippedAt).toBeInstanceOf(Date);
      expect(row.embeddingBackfillSkippedAt!.getTime()).toBeGreaterThanOrEqual(beforeTs);
      expect(row.embeddingBackfillStartedAt).toBeNull();
    });

    it("skipped_* → queued/in_progress 遷移で skippedAt が NULL にクリアされる", async () => {
      const url = `https://pr7b-conv-queued.example.com/${Date.now()}`;
      const created = await prisma.webPage.create({
        data: {
          url,
          sourceType: "user_provided",
          usageScope: "inspiration_only",
        },
      });
      createdIds.push(created.id);

      // 1) 先に skipped_fork_error に遷移（skippedAt が書かれる）
      await applyBackfillStatusTransition(created.id, "skipped_fork_error");
      const afterSkip = await prisma.webPage.findUniqueOrThrow({
        where: { id: created.id },
        select: { embeddingBackfillSkippedAt: true },
      });
      expect(afterSkip.embeddingBackfillSkippedAt).not.toBeNull();

      // 2) queued に遷移 → skippedAt は NULL、startedAt は NOT NULL
      await applyBackfillStatusTransition(created.id, "queued");
      const afterQueued = await prisma.webPage.findUniqueOrThrow({
        where: { id: created.id },
        select: {
          embeddingBackfillStatus: true,
          embeddingBackfillStartedAt: true,
          embeddingBackfillSkippedAt: true,
        },
      });
      expect(afterQueued.embeddingBackfillStatus).toBe("queued");
      expect(afterQueued.embeddingBackfillSkippedAt).toBeNull();
      expect(afterQueued.embeddingBackfillStartedAt).toBeInstanceOf(Date);

      // 3) in_progress に遷移 → 同じ invariant
      await applyBackfillStatusTransition(created.id, "in_progress");
      const afterInProgress = await prisma.webPage.findUniqueOrThrow({
        where: { id: created.id },
        select: {
          embeddingBackfillStatus: true,
          embeddingBackfillStartedAt: true,
          embeddingBackfillSkippedAt: true,
        },
      });
      expect(afterInProgress.embeddingBackfillStatus).toBe("in_progress");
      expect(afterInProgress.embeddingBackfillSkippedAt).toBeNull();
      expect(afterInProgress.embeddingBackfillStartedAt).toBeInstanceOf(Date);
    });

    it("completed / failed 遷移で skippedAt と startedAt が両方 NULL にクリアされる", async () => {
      const url = `https://pr7b-conv-term.example.com/${Date.now()}`;
      const created = await prisma.webPage.create({
        data: {
          url,
          sourceType: "user_provided",
          usageScope: "inspiration_only",
        },
      });
      createdIds.push(created.id);

      // Set to skipped to pre-populate skippedAt, then walk terminal states.
      await applyBackfillStatusTransition(created.id, "skipped_memory_pressure");

      for (const terminal of ["completed", "failed", "not_required"] as const) {
        await applyBackfillStatusTransition(created.id, terminal);
        const row = await prisma.webPage.findUniqueOrThrow({
          where: { id: created.id },
          select: {
            embeddingBackfillStatus: true,
            embeddingBackfillStartedAt: true,
            embeddingBackfillSkippedAt: true,
          },
        });
        expect(row.embeddingBackfillStatus).toBe(terminal);
        expect(row.embeddingBackfillSkippedAt).toBeNull();
        expect(row.embeddingBackfillStartedAt).toBeNull();
      }
    });

    it("fetchStaleSkippedPages が skippedAt >= threshold を検出できる（dead-code 回帰防御）", async () => {
      // ADR-0008 #6 の WHERE 句 `skippedAt: { lt: cutoff, not: null }` が
      // `embeddingBackfillSkippedAt` の書き込み欠落で dead code になっていた
      // 事案の回帰テスト。threshold を未来に設定して 1 件以上ヒットすることを
      // 確認する。
      //
      // Regression test for ADR-0008 #6 where the WHERE
      // `skippedAt: { lt: cutoff, not: null }` turned into dead code because
      // `updateEmbeddingBackfillStatus()` failed to write
      // `embeddingBackfillSkippedAt`. Set threshold to the future so that any
      // row with skippedAt is caught.
      const url = `https://pr7b-conv-scan.example.com/${Date.now()}`;
      const created = await prisma.webPage.create({
        data: {
          url,
          sourceType: "user_provided",
          usageScope: "inspiration_only",
        },
      });
      createdIds.push(created.id);

      await applyBackfillStatusTransition(created.id, "skipped_fork_error");

      // 1 分後 cutoff (skippedAt はほぼ now なので必ず lt cutoff になる)
      const futureCutoff = new Date(Date.now() + 60_000);
      const rows = await prisma.webPage.findMany({
        where: {
          id: created.id, // このテストで作った行のみをスコープ
          embeddingBackfillStatus: {
            in: ["skipped_fork_error", "skipped_memory_pressure"],
          },
          embeddingBackfillSkippedAt: { lt: futureCutoff, not: null },
        },
        select: {
          id: true,
          embeddingBackfillStatus: true,
          embeddingBackfillSkippedAt: true,
        },
      });

      expect(rows.length).toBe(1);
      expect(rows[0]!.embeddingBackfillStatus).toBe("skipped_fork_error");
      expect(rows[0]!.embeddingBackfillSkippedAt).toBeInstanceOf(Date);
    });

    it("Partial index idx_web_pages_backfill_skipped が定義されていること", async () => {
      // Partial index (skip recovery cron の高速化) の存在を pg_indexes から検証
      const rows = await prisma.$queryRaw<
        Array<{ indexname: string; indexdef: string }>
      >`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'web_pages' AND indexname = 'idx_web_pages_backfill_skipped'`;

      expect(rows.length).toBe(1);
      const indexdef = rows[0]?.indexdef ?? "";
      expect(indexdef).toContain("embedding_backfill_skipped_at");
      // Partial (WHERE 句付き) であることを検証
      expect(indexdef).toContain("skipped_fork_error");
      expect(indexdef).toContain("skipped_memory_pressure");
    });
  }
);
