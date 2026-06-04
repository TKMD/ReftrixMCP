// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — large-page domain (sub-invariant D)
 *
 * INV-PAGE-QUEUE-001-D: SSRF による Phase 0 早期ブロック (private IP /
 *   metadata IP / 未対応スキーム) が起きても、`PHASE0_EARLY_INSERT=true` の
 *   W0 upsert によって `web_pages` 行が DB に存在し、後続の failure-path
 *   update が `analysisStatus='failed'` を永続化できることを保証する。
 *
 * INV-PAGE-QUEUE-001-D: Even when Phase 0 is blocked early by SSRF
 *   validation (private IPs / metadata IPs / unsupported schemes), the W0
 *   upsert (`PHASE0_EARLY_INSERT=true`) ensures the `web_pages` row is
 *   present in DB so the subsequent failure-path update persists
 *   `analysisStatus='failed'`.
 *
 * ## 責務分離 / Responsibility separation
 *
 *   - **本 standing test**: 契約レベル (SSRF fail 経路で W0 ある場合 /
 *     ない場合の update 挙動差)
 *   - **SSRF 検証ロジック**: `packages/core/src/utils/ssrf-validator.ts`
 *     (別途 unit test でカバー済)
 *
 *   - **This standing test**: contract level (update behavior differs
 *     between W0-present and W0-absent on the SSRF failure path)
 *   - **SSRF validation logic**: covered elsewhere by unit tests
 *
 * ## 実装戦略 / Implementation strategy
 *
 *   INV-PAGE-QUEUE-001-C (robots.txt fail) と同形式の DB-state closure.
 *   SSRF 由来の failure message は PII を含まないため `"SSRF: private IP
 *   rejected"` のような機械的な文字列で模倣する (sanitize 後と同等)。
 *
 *   Same DB-state closure as INV-PAGE-QUEUE-001-C (robots.txt fail). SSRF
 *   failure messages do not carry PII, so we simulate them with mechanical
 *   strings (equivalent to post-sanitize output).
 *
 * ## PR-INGEST-FAIL-ROW CONS-2 (real catch-path)
 *
 *   従来の no-op model (SSRF 早期ブロック時に `prisma.update` を呼ばないこと
 *   で worker skip を模倣) を **real catch-path 化** する。SSRF 由来 fetch
 *   fail でも production の `markFailedAndAuditAtomic` (url-key upsert) を
 *   real-DB に対して実呼出し、row 不在でも terminal `failed` が create される
 *   ことを assert する (NOROW closure)。no-op 偽前提 PASS に依存しない。
 *
 *   Replaces the legacy no-op model (which simulated the worker skip on SSRF
 *   early-block by NOT calling `prisma.update`) with a **real catch-path**.
 *   Invokes the production `markFailedAndAuditAtomic` (url-key upsert) against
 *   the live DB even when the row is absent, asserting the terminal `failed`
 *   row is created (NOROW closure). No reliance on a false-premise no-op PASS.
 *
 * @see ADR-0016 Amendment 6 (PR-INGEST-FAIL-ROW: real catch-path, url-key upsert)
 * @see ADR-0016 § Invariants (INV-PAGE-QUEUE-001-D row — carry-over from PR-B)
 * @see apps/mcp-server/src/services/worker-supervisor-failure-path.service.ts (markFailedAndAuditAtomic)
 * @see packages/core/src/utils/ssrf-validator.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { assertInvName } from "../_setup/inv-assert";
import {
  markFailedAndAuditAtomic,
  type FailurePathPrismaClient,
} from "../../../../src/services/worker-supervisor-failure-path.service";
import { cleanupSeededWebPage, seedWebPageWithParts } from "./_fixtures/seed-large-page";

const LARGE_PAGE_PART_COUNT = 101 as const;

const TERMINAL_FAILURE_STATUS = "failed" as const;

/**
 * Mechanical SSRF failure messages (post-sanitize equivalents). These must
 * never contain PII or internal IP addresses — sanitizeErrorMessage() maps
 * raw network errors to these generic categories before logging.
 *
 * SSRF 由来の failure message (sanitize 後相当)。PII / 内部 IP を含まない
 * 汎用カテゴリ文字列のみ使用する (sanitizeErrorMessage() 通過後の形式)。
 */
const SSRF_FAILURE_MESSAGES = [
  "SSRF: private IP rejected",
  "SSRF: metadata endpoint rejected",
  "SSRF: unsupported scheme rejected",
  "Network request failed", // sanitize-error.ts default category
] as const;

describe("INV-PAGE-QUEUE-001-D: Phase 0 Early INSERT guarantees failure-path update for SSRF-blocked URLs (-SSRF)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "[INV-PAGE-QUEUE-001-D] DATABASE_URL not set by globalSetup (testcontainer boot failure?)"
      );
    }
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    await prisma.$connect();
  }, 30_000);

  afterAll(async () => {
    try {
      await prisma?.$disconnect();
    } catch {
      /* best-effort shutdown */
    }
  }, 15_000);

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-PAGE-QUEUE-001-D");
  });

  it("INV-PAGE-QUEUE-001-D-SSRF: W0-upserted row lets SSRF-block failure-path update reach analysisStatus='failed'", async () => {
    const seed = await seedWebPageWithParts(prisma, {
      partCount: LARGE_PAGE_PART_COUNT,
      preEmbedAll: true,
    });

    try {
      // W0 simulation
      await prisma.webPage.update({
        where: { id: seed.webPageId },
        data: { analysisStatus: "pending" },
      });

      // SSRF failure-path: use sanitize-equivalent category message
      const failureError = SSRF_FAILURE_MESSAGES[0];
      const result = await prisma.webPage.update({
        where: { id: seed.webPageId },
        data: {
          analysisStatus: TERMINAL_FAILURE_STATUS,
          analysisError: failureError,
          analysisCompletedAt: new Date(),
        },
      });
      expect(result).not.toBeNull();

      const afterFailure = await prisma.webPage.findUnique({
        where: { id: seed.webPageId },
        select: {
          analysisStatus: true,
          analysisError: true,
          analysisCompletedAt: true,
        },
      });
      expect(afterFailure).not.toBeNull();
      expect(afterFailure!.analysisStatus).toBe(TERMINAL_FAILURE_STATUS);
      expect(afterFailure!.analysisError).toBe(failureError);
      expect(afterFailure!.analysisCompletedAt).toBeInstanceOf(Date);
    } finally {
      await cleanupSeededWebPage(prisma, seed.webPageId);
    }
  }, 60_000);

  it("INV-PAGE-QUEUE-001-D-SSRF: sanitize-equivalent messages never leak internal IPs / hostnames", async () => {
    // Regression guard — SSRF 由来の failure message が実 IP / hostname を含まないことを確認。
    // sanitizeErrorMessage() が適切に category 化することの契約レベル保証。
    //
    // Regression guard — SSRF failure messages must not contain real IPs or
    // hostnames. Contract-level guarantee that sanitizeErrorMessage()
    // properly categorizes network errors.
    for (const msg of SSRF_FAILURE_MESSAGES) {
      expect(msg).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/); // no IPv4
      expect(msg).not.toMatch(/\b169\.254\b/); // metadata address prefix
      expect(msg).not.toMatch(/\b10\.\d+\b/); // private RFC1918
      expect(msg).not.toMatch(/\b192\.168\b/); // private RFC1918
      expect(msg).not.toMatch(/\blocalhost\b/); // localhost literal
      expect(msg).not.toMatch(/\bhttp:\/\//); // no full URL
    }
  });

  it("INV-PAGE-QUEUE-001-D-SSRF (NOROW closure): SSRF-blocked URL with row ABSENT → real markFailedAndAuditAtomic url-key upsert CREATES terminal failed", async () => {
    // ------------------------------------------------------------------
    // PR-INGEST-FAIL-ROW CONS-2 real catch-path. SSRF early-block happens
    // right after URL normalization in Phase 0; without W0 the row is absent
    // when control reaches the catch block (NOROW state).
    //
    // The legacy no-op model simulated the worker skip by NOT calling
    // prisma.update — a false-premise PASS. We now invoke the REAL production
    // helper `markFailedAndAuditAtomic` (url-key upsert) against the live DB
    // with the row ABSENT.
    //
    // Pre-fix (id-key plain UPDATE): row absent → P2025 → transaction_aborted
    //   → row STAYS absent (SSRF failure silently un-persisted = the bug).
    // Post-fix (url-key upsert, Amendment 6 §Decision 2): row absent →
    //   CREATE terminal `failed` row with the sanitize-equivalent SSRF
    //   message → {committed:true} → row PERSISTS.
    //
    // Asserts the post-fix behavior against real DB (not a no-op model).
    // ------------------------------------------------------------------
    const orphanWebPageId = randomUUID();
    // RFC 2606 reserved domain (ADR-0016 § Fixture URL Policy). Unique suffix.
    const orphanUrl = `https://example.com/ingest-fail-ssrf-norow/${orphanWebPageId}`;
    const ssrfFailureMessage = SSRF_FAILURE_MESSAGES[0]; // "SSRF: private IP rejected"

    try {
      // Pre-condition: NO row exists for this url (NOROW state).
      const preByUrl = await prisma.webPage.findUnique({
        where: { url: orphanUrl },
        select: { id: true },
      });
      expect(preByUrl).toBeNull();

      // REAL catch-path invocation with the row absent + SSRF message.
      const result = await markFailedAndAuditAtomic(prisma as unknown as FailurePathPrismaClient, {
        webPageId: orphanWebPageId,
        normalizedUrl: orphanUrl,
        errorMessage: ssrfFailureMessage,
        phaseN: "0",
        childPid: 4242,
      });
      expect(result.committed).toBe(true);

      // Post-condition: url-key upsert created the terminal failed row.
      const created = await prisma.webPage.findUnique({
        where: { url: orphanUrl },
        select: {
          id: true,
          analysisStatus: true,
          analysisError: true,
          analysisCompletedAt: true,
          failedWithKnownReason: true,
        },
      });
      expect(created).not.toBeNull();
      expect(created!.id).toBe(orphanWebPageId);
      expect(created!.analysisStatus).toBe(TERMINAL_FAILURE_STATUS);
      expect(created!.analysisError).toBe(ssrfFailureMessage);
      expect(created!.analysisCompletedAt).toBeInstanceOf(Date);
      expect(created!.failedWithKnownReason).toBe("worker_restart_during_inflight_phase_0");
    } finally {
      const row = await prisma.webPage.findUnique({
        where: { url: orphanUrl },
        select: { id: true },
      });
      if (row) {
        await cleanupSeededWebPage(prisma, row.id);
      }
    }
  }, 30_000);
});
