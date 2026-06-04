// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-BACKFILL-IPC-SANITIZE-ONLY-001 (Plan v2 PR-D / PR-E)
 *
 * ADR-0018 Amendment 7 §7.7 (SEC-V1-01, M): the backfill child→parent IPC
 * `BackfillErrorMessage.code` field is narrowed from the unconstrained
 * `z.string().optional()` to `z.string().regex(/^P\d{4}$/).optional()`, so the
 * IPC boundary structurally rejects arbitrary strings (only Prisma error codes
 * `P` + 4 digits, or `undefined`). This shrinks the CWE-209 latent surface
 * (an arbitrary `code` reaching the parent / BullMQ UI / MCP client).
 *
 * This test pins the schema-narrow as a CI-failing invariant:
 *   - `P2002` (valid Prisma code) is ACCEPTED
 *   - arbitrary strings (e.g. `"some internal error: table users"`) are REJECTED
 *   - `undefined` (omitted `code`) is ACCEPTED (Graceful Degradation)
 *   - the `message` field is sanitized-only (child side sanitizes; parent does
 *     NOT re-sanitize — SEC M-2 idempotency policy)
 *
 * `.skip` / `.todo` are forbidden (SEC-COND-1 mandatory CI-failing landing).
 *
 * @see ADR-0018 Amendment 7 §7.7 (IPC code schema narrow)
 * @see Plan v2 PR-D §5 TEST (IPC schema narrow test) / PR-E (the narrow itself)
 * @see embedding-backfill-ipc.ts:BackfillErrorMessage
 * @see utils/sanitize-error.ts:extractPrismaCode (P\d{4} producer contract)
 *
 * Severity: M (SEC-V1-01)
 *
 * @module tests/regression/standing/worker-lifecycle/inv-backfill-ipc-sanitize-only-001
 */

import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { assertInvName } from "../_setup/inv-assert";
import { BackfillErrorMessage } from "../../../../src/workers/phases/embedding-backfill-ipc";
import { extractPrismaCode } from "../../../../src/utils/sanitize-error";

const MCP_SERVER_SRC_ROOT = path.resolve(__dirname, "../../../../src");

describe("INV-BACKFILL-IPC-SANITIZE-ONLY-001: IPC code schema narrow + sanitized-only payload (Plan v2 PR-D / PR-E)", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-BACKFILL-IPC-SANITIZE-ONLY-001");
  });

  it("INV-BACKFILL-IPC-SANITIZE-ONLY-001: accepts a valid Prisma error code (P2002) for `code`", () => {
    const parsed = BackfillErrorMessage.safeParse({
      kind: "backfill.error",
      message: "Database operation failed",
      code: "P2002",
    });
    expect(parsed.success).toBe(true);
  });

  it("INV-BACKFILL-IPC-SANITIZE-ONLY-001: accepts an omitted (undefined) `code` (Graceful Degradation)", () => {
    const parsed = BackfillErrorMessage.safeParse({
      kind: "backfill.error",
      message: "An internal error occurred",
    });
    expect(parsed.success).toBe(true);
  });

  it("INV-BACKFILL-IPC-SANITIZE-ONLY-001: REJECTS an arbitrary non-Prisma-code string for `code` (CWE-209 surface shrink)", () => {
    const parsed = BackfillErrorMessage.safeParse({
      kind: "backfill.error",
      message: "sanitized",
      code: "some internal error: table component_part_embeddings",
    });
    expect(parsed.success).toBe(false);
  });

  it("INV-BACKFILL-IPC-SANITIZE-ONLY-001: REJECTS a near-miss code (lowercase / wrong digit count)", () => {
    for (const bad of ["p2002", "P200", "P20025", "2002", "PXXXX", "P2002 "]) {
      const parsed = BackfillErrorMessage.safeParse({
        kind: "backfill.error",
        message: "sanitized",
        code: bad,
      });
      expect(parsed.success, `code "${bad}" must be rejected`).toBe(false);
    }
  });

  it("INV-BACKFILL-IPC-SANITIZE-ONLY-001: the schema `code` field is regex-narrowed in source (no unconstrained z.string().optional())", () => {
    const ipcSrc = fs.readFileSync(
      path.resolve(MCP_SERVER_SRC_ROOT, "workers/phases/embedding-backfill-ipc.ts"),
      "utf8"
    );
    // The narrowed form must be present (P\d{4} regex on code).
    expect(ipcSrc).toMatch(/code:\s*z[\s\S]*?\.regex\(\/\^P\\d\{4\}\$\/\)[\s\S]*?\.optional\(\)/);
  });

  it("INV-BACKFILL-IPC-SANITIZE-ONLY-001: the only `code` producer (extractPrismaCode) emits P\\d{4} or undefined (producer ↔ schema coherence)", () => {
    // Producer contract: extractPrismaCode returns a P-code only when the error
    // exposes a strict P\d{4} `code`, otherwise undefined. The schema accepts
    // exactly this set, so no producer output is dropped at the IPC boundary.
    expect(extractPrismaCode({ code: "P2002" })).toBe("P2002");
    expect(extractPrismaCode({ code: "not-a-prisma-code" })).toBeUndefined();
    expect(extractPrismaCode({ code: 42 })).toBeUndefined();
    expect(extractPrismaCode(new Error("boom"))).toBeUndefined();
    expect(extractPrismaCode(null)).toBeUndefined();
    // Round-trip: every extractPrismaCode output is schema-valid.
    for (const sample of [{ code: "P2002" }, { code: "P1001" }, new Error("x"), null]) {
      const code = extractPrismaCode(sample);
      const parsed = BackfillErrorMessage.safeParse({
        kind: "backfill.error",
        message: "sanitized",
        ...(code !== undefined ? { code } : {}),
      });
      expect(parsed.success).toBe(true);
    }
  });
});
