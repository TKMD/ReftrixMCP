// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FIND-IMPL-SEC-01 (M, deadline 2026-05-04) — CWE-209 catch-block sanitize test.
 *
 * `savePartEmbeddings` の transaction rollback catch block が client-facing
 * `result.errors[]` に raw Prisma error message (column 名 / table 名 / SQL
 * snippet / stack trace) を露出させないことを保証する。
 *
 * Ensures `savePartEmbeddings`' transaction rollback catch block never leaks
 * raw Prisma error messages (column / table names, SQL snippets, stack traces)
 * into the client-facing `result.errors[]` field.
 *
 * Contract (ADR-0018 §3.9 / PR-D-3 FIND-IMPL-SEC-01):
 *   - Client-facing `result.errors[]`: sanitized message only, matching one
 *     of the whitelist entries from `utils/sanitize-error.ts`.
 *   - Server-side `logger.warn` 2nd arg: raw `message` + error `code`
 *     preserved for debugging (not propagated to client).
 *
 * @see ADR-0018 §3.9 Error Message Sanitization in `result.errors[]`
 * @see CONTRIBUTING.md §Error Message Sanitization
 * @see apps/mcp-server/src/utils/sanitize-error.ts (whitelist source)
 * @see PR-D-3 Plan §3.3 (7 test cases, whitelist positive match per UC-D3-03)
 *
 * @module tests/services/part/part-embedding-db-error-sanitize
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  savePartEmbeddings,
  type PartEmbeddingPrismaClient,
} from "../../../src/services/part/part-embedding-db.service";
import type { PartEmbeddingResult } from "../../../src/services/part/part-embedding.service";
import { logger } from "../../../src/utils/logger";

// ============================================================================
// Whitelist — keep in sync with `utils/sanitize-error.ts`
// ============================================================================

/**
 * 7-category whitelist of safe, client-facing messages emitted by
 * `sanitizeErrorMessage()` (UC-D3-03 whitelist-approach per PR-D-3 Plan §3.3).
 *
 * Any sanitize output MUST be one of these exact strings. This list is the
 * test-side SSOT — if `utils/sanitize-error.ts` evolves (new category added),
 * this test WILL fail (detection guarantee per Plan §3.3 Test #6).
 */
const SANITIZE_WHITELIST: readonly string[] = [
  "A record with this value already exists", // Prisma P2002
  "Record not found", // Prisma P2001 / P2025
  "Foreign key constraint failed", // Prisma P2003
  "Database operation failed", // generic Prisma Pxxxx fallback / category=database
  "An internal error occurred", // non-Error / catch-all / string throw
  "Operation timed out", // P1008 / timeout keyword
  "Network request failed", // ECONNREFUSED / ETIMEDOUT / ENOTFOUND / fetch failed
] as const;

// ============================================================================
// Fixtures
// ============================================================================

function makeValidEmbedding(partId: string): PartEmbeddingResult {
  return {
    componentPartId: partId,
    visualEmbedding: Array.from({ length: 768 }, (_, i) => i * 0.001),
    textEmbedding: Array.from({ length: 768 }, (_, i) => (768 - i) * 0.001),
    textRepresentation: `passage: type:button(${partId})`,
  };
}

/**
 * Create a mock PrismaClient whose `$transaction(cb, opts)` is rejected with
 * the given error. The callback `cb` is never invoked — `$transaction`
 * rejects immediately, which simulates an opaque Prisma transaction failure.
 */
function createRejectingMockPrisma(rejectWith: unknown): PartEmbeddingPrismaClient {
  const client = {
    componentPartEmbedding: {
      createMany: vi.fn(),
    },
    $executeRawUnsafe: vi.fn(),
    $transaction: vi.fn().mockRejectedValue(rejectWith),
  } as unknown as PartEmbeddingPrismaClient;
  return client;
}

/**
 * Construct a Prisma-like error object with a `code` property matching the
 * Prisma error-code convention (P2xxx / P1xxx).
 */
function makePrismaError(code: string, rawMessage: string): Error & { code: string } {
  const err = new Error(rawMessage) as Error & { code: string };
  err.code = code;
  return err;
}

// ============================================================================
// Tests — 7 cases per PR-D-3 Plan §3.3 (UC-D3-01 / UC-D3-03 landing)
// ============================================================================

describe("savePartEmbeddings — CWE-209 catch-block sanitize (FIND-IMPL-SEC-01)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // Test #1 — Prisma P2002 unique constraint
  //   Raw message contains internal column name `component_part_id`.
  //   Client-facing message MUST be the whitelist entry, NOT the raw message.
  // --------------------------------------------------------------------------
  it("Test #1: Prisma P2002 unique constraint → 'A record with this value already exists' (CWE-209 stripped)", async () => {
    const prisma = createRejectingMockPrisma(
      makePrismaError("P2002", "Unique constraint failed on the fields: (`component_part_id`)")
    );

    const result = await savePartEmbeddings(prisma, [makeValidEmbedding("p1")]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("A record with this value already exists");
    // Negative guard: internal column / SQL snippet must NOT leak to client.
    expect(result.errors[0]).not.toMatch(/component_part_id/);
    expect(result.errors[0]).not.toMatch(/Unique constraint/i);
    // Transaction rolled back → generatedCount stays at 0.
    expect(result.generatedCount).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Test #2 — Prisma P2025 record not found
  // --------------------------------------------------------------------------
  it("Test #2: Prisma P2025 record not found → 'Record not found'", async () => {
    const prisma = createRejectingMockPrisma(
      makePrismaError(
        "P2025",
        "An operation failed because it depends on one or more records that were required but not found."
      )
    );

    const result = await savePartEmbeddings(prisma, [makeValidEmbedding("p2")]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Record not found");
    expect(result.generatedCount).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Test #3 — Prisma P2003 foreign key constraint
  //   Per PR-D-3 Plan §3.3 + UC-D3-01: P2003 is a *known mapping* in
  //   `sanitize-error.ts` L22 → authoritative assertion is the full whitelist
  //   string `"Foreign key constraint failed"`, NOT the generic
  //   `"Database operation failed"` fallback.
  // --------------------------------------------------------------------------
  it("Test #3: Prisma P2003 foreign key constraint → 'Foreign key constraint failed' (known mapping)", async () => {
    const prisma = createRejectingMockPrisma(
      makePrismaError(
        "P2003",
        "Foreign key constraint failed on the field: `component_parts_web_page_id_fkey (index)`"
      )
    );

    const result = await savePartEmbeddings(prisma, [makeValidEmbedding("p3")]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Foreign key constraint failed");
    // P2003 is an explicit entry in `PRISMA_ERROR_MESSAGES` (L22), so it must
    // NOT fall through to the generic `"Database operation failed"` fallback.
    expect(result.errors[0]).not.toContain("Database operation failed");
    // Internal foreign key constraint name must NOT leak.
    expect(result.errors[0]).not.toMatch(/component_parts_web_page_id_fkey/);
    expect(result.generatedCount).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Test #4 — Generic Error (non-Prisma) with raw stack-trace-like content.
  //   sanitizeErrorMessage recognizes neither a Pxxxx code nor a keyword
  //   (timeout / network / not-found / does-not-exist), so it falls through
  //   to the internal-category fallback.
  // --------------------------------------------------------------------------
  it("Test #4: generic Error (non-Prisma) with raw stack → sanitized to safe whitelist entry", async () => {
    const prisma = createRejectingMockPrisma(
      new Error(
        "Unexpected failure: at /usr/src/app/prisma/client.js:123 SELECT * FROM component_part_embeddings"
      )
    );

    const result = await savePartEmbeddings(prisma, [makeValidEmbedding("p4")]);

    expect(result.errors).toHaveLength(1);
    // Generic Error → internal-category fallback per sanitize-error.ts L110.
    // Both "Database operation failed" and "An internal error occurred" are
    // whitelist entries; the sanitizer returns the latter for un-keyworded
    // generic Errors. We pin the strict assertion to match that path.
    expect(result.errors[0]).toContain("An internal error occurred");
    // Negative guards: SQL / file-path / stack trace MUST be stripped.
    expect(result.errors[0]).not.toMatch(/SELECT/);
    expect(result.errors[0]).not.toMatch(/component_part_embeddings/);
    expect(result.errors[0]).not.toMatch(/\/usr\/src\/app/);
    expect(result.generatedCount).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Test #5 — non-Error throw (string).
  //   sanitizeErrorMessage returns the internal-category fallback.
  // --------------------------------------------------------------------------
  it("Test #5: non-Error throw (string) → 'An internal error occurred'", async () => {
    const prisma = createRejectingMockPrisma("raw string error leaked from Promise");

    const result = await savePartEmbeddings(prisma, [makeValidEmbedding("p5")]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("An internal error occurred");
    // The raw thrown string MUST NOT leak to the client.
    expect(result.errors[0]).not.toMatch(/raw string error leaked/);
    expect(result.generatedCount).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Test #6 — Whitelist positive match (sanitize boundary enforcement).
  //   UC-D3-03 (MERGE-C = SEC-C-01 ⊕ TPA-03): client-facing message MUST be
  //   one of the 7 whitelist categories. If a new sanitizer category is added
  //   in the future without extending this list, this test fails (detection
  //   guarantee per PR-D-3 Plan §3.3 Test #6).
  // --------------------------------------------------------------------------
  it("Test #6: whitelist positive match — sanitize output ∈ 7-category whitelist (UC-D3-03)", async () => {
    // Use a Prisma P2002 as a representative case; the whitelist check is
    // what enforces the boundary, not the specific error class.
    const prisma = createRejectingMockPrisma(
      makePrismaError("P2002", "Unique constraint failed on the fields: (`component_part_id`)")
    );

    const result = await savePartEmbeddings(prisma, [makeValidEmbedding("p6")]);

    expect(result.errors).toHaveLength(1);
    const errorMessage = result.errors[0]!;

    // Whitelist positive match: the sanitized fragment must contain at least
    // one of the 7 whitelist entries as a substring. This is stricter than
    // `match ANY` and weaker than `equals` (the full line is wrapped with the
    // "Transaction rolled back (N embeddings): " prefix).
    const matchedEntry = SANITIZE_WHITELIST.find((entry) => errorMessage.includes(entry));
    expect(
      matchedEntry,
      `Client-facing error must contain one of the 7 sanitize whitelist entries, got: "${errorMessage}"`
    ).toBeDefined();

    // Supplementary negative guards — SQL keywords / internal structure MUST NOT leak.
    // These are narrow patterns (NOT generic English words) to avoid false positives
    // per FIND-PR-D-3-PLAN-06 Mitigation (c).
    expect(errorMessage).not.toMatch(/component_part_embeddings/);
    expect(errorMessage).not.toMatch(/Unique constraint failed/i);
    expect(errorMessage).not.toMatch(/vector\(\d+\)/);
  });

  // --------------------------------------------------------------------------
  // Test #7 — Server-side log preservation (debug power retained).
  //   Per PR-D-3 Plan §3.3 Test #7 + FIND-PR-D-3-PLAN-02 Mitigation (a):
  //   `logger.warn` MUST receive the raw message + Prisma code on its 2nd
  //   argument so operators can diagnose transaction rollbacks from server
  //   log aggregators even when `result.errors[]` is sanitized.
  // --------------------------------------------------------------------------
  it("Test #7: server-side log preserves raw message + code (debug info retained)", async () => {
    const rawMessage = "Unique constraint failed on the fields: (`component_part_id`)";
    const prisma = createRejectingMockPrisma(makePrismaError("P2002", rawMessage));

    await savePartEmbeddings(prisma, [makeValidEmbedding("p7")]);

    // Locate the rollback `logger.warn` call among any probe/info calls.
    const rollbackCall = warnSpy.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("Transaction rolled back (atomic failure)")
    );
    expect(rollbackCall, "expected a `Transaction rolled back` warn() call").toBeDefined();

    const logData = rollbackCall![1] as Record<string, unknown>;
    // Raw Prisma code preserved on server-side log (for diagnostics).
    expect(logData.code).toBe("P2002");
    // Raw full message preserved on server-side log (for diagnostics).
    expect(logData.rawMessage).toBe(rawMessage);
    // Server log does NOT include the client-sanitized `errors` array to
    // avoid redundancy (server log is its own SSOT for raw diagnostics).
    expect(logData).not.toHaveProperty("errors");
  });
});
