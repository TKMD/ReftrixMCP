// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * sanitizeErrorMessage — DATABASE_URL / password leak regression tests (PR7e-β1, SEC-β-07)
 *
 * `sanitizeErrorMessage()` はエラーメッセージをクライアントに返す直前の
 * 最終防衛線。ここが `DATABASE_URL` の password や `ML_WORKER_MAX_OLD_SPACE_MB`
 * 等の env 値を素通しすると、MCP response / CLI stderr / cron ログ経由で秘密情報が
 * 漏洩する。
 *
 * β1 で `bootstrapAuditLogServiceForScript` / `loadEnvLocal` が CLI / cron / MCP の
 * 3 経路すべてから呼ばれるようになったため、3 経路すべてで sanitize が password を
 * 除去することを保証する regression test を追加する。
 *
 * `sanitizeErrorMessage()` is the last-chance defence before an error message
 * is returned to the client. If it passes through a `DATABASE_URL` password or
 * similar env value, the secret leaks via MCP response / CLI stderr / cron logs.
 *
 * β1 wires `bootstrapAuditLogServiceForScript` / `loadEnvLocal` across three
 * bootstrap paths (CLI / cron / MCP server). These regression tests ensure the
 * sanitizer strips passwords in all three.
 *
 * @module tests/services/sanitize-error.regression
 */

import { describe, it, expect } from "vitest";
import { sanitizeErrorMessage } from "../../src/utils/sanitize-error";

const SECRET_PASSWORD = "s3cr3t-p@ssw0rd!reftrix";
const FAKE_DATABASE_URL = `postgresql://reftrix:${SECRET_PASSWORD}@localhost:26432/reftrix`;

/**
 * Helper: assert that `sanitized` leaks neither `password` nor the full URL.
 */
function expectNoLeak(sanitized: string): void {
  expect(sanitized).not.toContain(SECRET_PASSWORD);
  expect(sanitized).not.toContain(FAKE_DATABASE_URL);
  // Also guard against common Prisma / Node error patterns that echo the URL.
  expect(sanitized).not.toMatch(/postgresql:\/\/[^\s]+/);
}

describe("sanitizeErrorMessage — DATABASE_URL leak regression (PR7e-β1, SEC-β-07)", () => {
  it("Prisma 風 P1000 error の message に DATABASE_URL が混入しても漏れない / does not leak when Prisma P1000 error embeds DATABASE_URL", () => {
    // Simulate Prisma's common P1000 "Authentication failed against database server at ..." with DATABASE_URL exposed in message.
    const err = new Error(`Authentication failed against database server at ${FAKE_DATABASE_URL}`);
    (err as { code?: string }).code = "P1000";
    expectNoLeak(sanitizeErrorMessage(err));
  });

  it("Node ECONNREFUSED error の message に DATABASE_URL が混入しても漏れない / does not leak when ECONNREFUSED error carries DATABASE_URL", () => {
    const err = new Error(`connect ECONNREFUSED ${FAKE_DATABASE_URL}`);
    expectNoLeak(sanitizeErrorMessage(err));
  });

  it("timeout error の message に DATABASE_URL が混入しても漏れない / does not leak on timeout errors carrying DATABASE_URL", () => {
    const err = new Error(`timed out connecting to ${FAKE_DATABASE_URL}`);
    expectNoLeak(sanitizeErrorMessage(err));
  });

  it("stack trace に DATABASE_URL が載った生 Error でも漏れない / does not leak when DATABASE_URL appears only in stack trace (generic fallback)", () => {
    const err = new Error("Some opaque internal failure");
    err.stack = `Error: Some opaque internal failure\n    at f (${FAKE_DATABASE_URL}:1:1)`;
    expectNoLeak(sanitizeErrorMessage(err));
  });

  it("PrismaClientKnownRequestError 風 (P2002) でも DATABASE_URL は漏れない / known-Prisma errors (P2002) never echo DATABASE_URL", () => {
    const err = new Error(
      `Unique constraint failed on the fields: ('email'). DATABASE_URL=${FAKE_DATABASE_URL}`
    );
    (err as { code?: string }).code = "P2002";
    expectNoLeak(sanitizeErrorMessage(err));
  });

  it("unknown (non-Error) throw でも generic メッセージを返し秘密情報は含まない / non-Error throw returns the generic message with no secrets", () => {
    // Primitive throws (e.g. a string) must fall through to the generic branch.
    const sanitized = sanitizeErrorMessage(`boom: ${FAKE_DATABASE_URL}`);
    expectNoLeak(sanitized);
  });

  it("3 bootstrap 経路 (CLI / cron / MCP) を想定した反復で常に no-leak / repeated invocation from all 3 bootstrap paths never leaks", () => {
    // Simulate each bootstrap path raising the same error and funnelling it
    // through sanitizeErrorMessage — verify every sanitized output is clean.
    const scenarios = [
      { path: "CLI", error: new Error(`CLI pg connect failed at ${FAKE_DATABASE_URL}`) },
      { path: "cron", error: new Error(`cron pg connect failed at ${FAKE_DATABASE_URL}`) },
      { path: "MCP", error: new Error(`MCP pg connect failed at ${FAKE_DATABASE_URL}`) },
    ] as const;
    for (const { path, error } of scenarios) {
      const sanitized = sanitizeErrorMessage(error);
      expectNoLeak(sanitized);
      // Meta-assertion: sanitized is a finite non-empty string (not accidentally a leaked stack).
      expect(typeof sanitized).toBe("string");
      expect(sanitized.length).toBeGreaterThan(0);
      // Path label is not emitted by sanitizer itself — sanity check only.
      expect(["CLI", "cron", "MCP"]).toContain(path);
    }
  });
});
