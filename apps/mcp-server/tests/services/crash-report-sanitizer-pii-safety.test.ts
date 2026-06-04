// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Crash Report Sanitizer — PII Safety SEC sign-off evidence pack (Wave 3 PR3a)
 *
 * Plan v3 T2 V1 §13.1 SEC sign-off evidence #2: **6 PII unit tests** as CI-failing
 * executable evidence for BLOCK → CONDITIONAL transition.
 *
 * Tests #1-6 cover the Δ2 contract:
 *   #1 sensitive env (DATABASE_URL / REDIS_PASSWORD / OPENAI_API_KEY) redact
 *   #2 argv URL redact
 *   #3 argv UUID boot token redact
 *   #4 file path JS stack normalisation
 *   #5 heap string PII strip (postgres:// inside arbitrary heap field)
 *   #6 sanitiser fail-open: throw → SLO_MARKER log + sanitizationApplied=false
 *
 * @see Plan v3 T2 V1 §7.1 Δ2 #1-6 + §13.1 evidence pack
 * @see INV-WORKER-CRASH-DUMP-001 pii-leak-fail-closed standing regression
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  sanitizeReport,
  SLO_MARKER_SANITIZE_FAILED,
  REDACTED_VALUE,
  REDACTED_URL,
  REDACTED_UUID,
  resetSequenceForTesting,
  resetRepoRootCacheForTesting,
} from "../../src/services/crash-report-sanitizer";
import { logger } from "../../src/utils/logger";

describe("crash-report-sanitizer — PII safety SEC sign-off evidence pack (V1 §13.1 #2)", () => {
  beforeEach(() => {
    resetSequenceForTesting();
    resetRepoRootCacheForTesting();
    process.env.REFTRIX_REPO_ROOT = "/home/test/Reftrix";
  });

  // ============================================================================
  // Test #1: sensitive env key redaction
  // (DATABASE_URL, REDIS_PASSWORD, OPENAI_API_KEY → [REDACTED])
  // ============================================================================
  it("Test #1 — redacts sensitive env keys via SSOT AUDIT_SENSITIVE_KEYS", () => {
    const rawReport = {
      environmentVariables: {
        DATABASE_URL: "postgres://user:pw@host:5432/db",
        REDIS_PASSWORD: "supersecret",
        OPENAI_API_KEY: "sk-1234567890abcdef",
        NODE_ENV: "production",
      },
    };
    const result = sanitizeReport(rawReport);
    const r = result.report as Record<string, unknown>;
    const env = r.environmentVariables as Record<string, string>;
    expect(env.DATABASE_URL).toBe(REDACTED_VALUE);
    expect(env.REDIS_PASSWORD).toBe(REDACTED_VALUE);
    expect(env.OPENAI_API_KEY).toBe(REDACTED_VALUE);
    expect(env.NODE_ENV).toBe("production");
    expect(result.sanitizationApplied).toBe(true);
  });

  // ============================================================================
  // Test #2: argv URL redaction
  // (https://example.com/page → [REDACTED-URL])
  // ============================================================================
  it("Test #2 — redacts URLs from argv commandLine", () => {
    const rawReport = {
      header: {
        commandLine: [
          "node",
          "worker.js",
          "https://example.com/page",
          "--target=http://api.test/v1",
        ],
      },
    };
    const result = sanitizeReport(rawReport);
    const r = result.report as Record<string, unknown>;
    const header = r.header as Record<string, unknown>;
    const argv = header.commandLine as string[];
    expect(argv[0]).toBe("node");
    expect(argv[1]).toBe("worker.js");
    expect(argv[2]).toBe(REDACTED_URL);
    expect(argv[3]).toContain(REDACTED_URL);
    expect(argv[3]).not.toContain("api.test/v1");
    // Hard contract: no element should contain a literal `://`.
    expect(argv.every((arg) => !arg.match(/https?:\/\//))).toBe(true);
  });

  // ============================================================================
  // Test #3: argv UUID boot token redaction
  // (019e1263-... → [REDACTED-UUID])
  // ============================================================================
  it("Test #3 — redacts UUID boot tokens from argv commandLine", () => {
    const rawReport = {
      header: {
        commandLine: [
          "node",
          "worker.js",
          "019e1263-f81a-7448-9334-0f2422f1982b", // v7
          "550e8400-e29b-41d4-a716-446655440000", // v4
          "--page",
        ],
      },
    };
    const result = sanitizeReport(rawReport);
    const r = result.report as Record<string, unknown>;
    const header = r.header as Record<string, unknown>;
    const argv = header.commandLine as string[];
    expect(argv[2]).toBe(REDACTED_UUID);
    expect(argv[3]).toBe(REDACTED_UUID);
    expect(argv[4]).toBe("--page");
    // Hard contract: no element should match canonical UUID regex.
    expect(
      argv.every(
        (arg) =>
          !arg.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
      )
    ).toBe(true);
  });

  // ============================================================================
  // Test #4: file path JS stack normalisation
  // (in-repo → relative `apps/mcp-server/...`; out-of-repo → [REDACTED-NON-REPO-PATH])
  // ============================================================================
  it("Test #4 — normalises file paths in JS stack frames", () => {
    const rawReport = {
      javascriptStack: {
        stack: [
          "at handler (/home/test/Reftrix/apps/mcp-server/src/x.ts:10:5)",
          "at internal (/home/test/secrets/leaked.json:1:1)",
          "at edge (/etc/passwd:1:1)",
        ],
      },
    };
    const result = sanitizeReport(rawReport);
    const r = result.report as Record<string, unknown>;
    const jsStack = r.javascriptStack as Record<string, unknown>;
    const stack = jsStack.stack as string[];
    // Hard contract: every frame must either start with `apps/mcp-server/` (or other
    // repo subdir) or contain [REDACTED-NON-REPO-PATH] / be a built-in name.
    expect(stack[0]).toContain("apps/mcp-server/src/x.ts");
    expect(stack[0]).not.toContain("/home/test/Reftrix");
    expect(stack[1]).toContain("[REDACTED-NON-REPO-PATH]");
    expect(stack[2]).toContain("[REDACTED-NON-REPO-PATH]");
  });

  // ============================================================================
  // Test #5: heap string PII strip
  // (javascriptHeap field containing "postgres://..." → URL stripped)
  // ============================================================================
  it("Test #5 — strips embedded PII URLs from heap string fields (CWE-209)", () => {
    const rawReport = {
      javascriptHeap: {
        totalMemory: 12345,
        // Simulate a heap snapshot field containing a leaked connection string.
        leakedField: "Connection refused for postgres://user:pw@host:5432/db",
        nestedField: {
          status: "error",
          message: "ETIMEDOUT to redis://cache.host:6379",
        },
      },
    };
    const result = sanitizeReport(rawReport);
    const r = result.report as Record<string, unknown>;
    const heap = r.javascriptHeap as Record<string, unknown>;
    expect(heap.totalMemory).toBe(12345);
    expect(heap.leakedField as string).not.toContain("postgres://");
    expect(heap.leakedField as string).toContain(REDACTED_URL);
    const nested = heap.nestedField as Record<string, unknown>;
    expect(nested.message as string).not.toContain("redis://");
    // Hard contract: no string anywhere in the heap object should contain postgres:// or redis://
    const stringified = JSON.stringify(heap);
    expect(stringified).not.toContain("postgres://");
    expect(stringified).not.toContain("redis://");
    expect(result.sanitizationApplied).toBe(true);
  });

  // ============================================================================
  // Test #6: sanitiser fail-open path
  // (throw → SLO_MARKER log + sanitizationApplied=false)
  // ============================================================================
  it("Test #6 — fail-open on sanitiser exception emits SLO_MARKER + sanitizationApplied=false", () => {
    // Spy on logger.warn so we can assert the SLO_MARKER fires.
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {
      /* swallow log output for test */
    });
    try {
      // Build a poisoned report whose JSON serialisation throws (circular ref).
      // `JSON.stringify` will TypeError on circular structures, which triggers
      // the catch block in sanitizeReport.
      type Poisoned = { self?: Poisoned; data?: string };
      const poisoned: Poisoned = { data: "value" };
      poisoned.self = poisoned;
      const result = sanitizeReport(poisoned);
      // Fail-open contract: original report returned, applied=false, SLO logged.
      expect(result.sanitizationApplied).toBe(false);
      expect(result.report).toBe(poisoned);
      // Verify the SLO marker was emitted with the canonical message.
      const calls = warnSpy.mock.calls;
      const sloCall = calls.find((c) => c[0] === SLO_MARKER_SANITIZE_FAILED);
      expect(sloCall).toBeDefined();
      // Verify Δ5 Metric A trigger condition: sanitizationApplied=false.
      // Downstream audit emit (worker_crash_report_emitted) will surface this
      // and the GDPR Art.33 escalate gate evaluates the 60-min window count.
      expect(result.sanitizationApplied).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ============================================================================
// Additional cross-cutting hardening: ensure that NO PII pattern survives
// in the final stringified report (defense-in-depth assertion).
// ============================================================================

describe("crash-report-sanitizer — global cross-cutting PII assertion", () => {
  beforeEach(() => {
    resetSequenceForTesting();
    resetRepoRootCacheForTesting();
    process.env.REFTRIX_REPO_ROOT = "/home/test/Reftrix";
  });

  it("no PII pattern survives across the full sanitised report", () => {
    const rawReport = {
      header: {
        commandLine: [
          "node",
          "worker.js",
          "https://example.com",
          "019e1263-f81a-7448-9334-0f2422f1982b",
        ],
        cwd: "/home/test/Reftrix",
      },
      environmentVariables: {
        DATABASE_URL: "postgres://user:pw@host:5432/db",
        REDIS_PASSWORD: "secret",
        STRIPE_SECRET_KEY: "sk_live_abc",
      },
      javascriptStack: {
        message: "ETIMEDOUT postgres://leak",
        stack: ["at fn (/home/test/secrets/.env:1:1)"],
      },
      nativeStack: ["__libc_malloc"],
      javascriptHeap: {
        leaked: "redis://leaked:6379",
      },
    };
    const result = sanitizeReport(rawReport);
    expect(result.sanitizationApplied).toBe(true);
    const serialised = JSON.stringify(result.report);
    // Hard cross-cutting contract: no PII fragment may leak through.
    expect(serialised).not.toContain("postgres://");
    expect(serialised).not.toContain("redis://");
    expect(serialised).not.toContain("https://example.com");
    expect(serialised).not.toContain("019e1263-f81a-7448-9334-0f2422f1982b");
    expect(serialised).not.toContain("/home/test/secrets");
    expect(serialised).not.toContain("__libc_malloc");
    expect(serialised).not.toContain("sk_live_abc");
  });
});
