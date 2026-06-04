// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-WORKER-STDERR-ISOLATION-001
 *
 * **Plan v4.5 PR1 LCC-H-01 / ADR-0036 §D4 + §Accepted-Risk #4**
 *
 * IO Plan Decision V3 anchor: `019e3843-70e8-73de`
 * IO Impl Decision V0 BLOCK closure (SEC-V45-PR1-H-NEW-1 remediation) anchor: `019e386a-58cf-7138`
 *
 * ## Contract / 不変条件 (3 invariants)
 *
 * 1. **PII sanitisation enforcement (semantic)** — `sanitizeStderrChunk` MUST
 *    redact URL / absolute path / Windows path / PostgreSQL connection /
 *    Base64 embedding payload / JWT-like via the **dedicated regex set**
 *    (independent design — `sanitizeErrorMessage` canonical SSOT is NOT
 *    invoked here per IO V0 Option A, to preserve observable stack-trace
 *    structure required for PR1 P0.5 runtime debug observability).
 * 2. **Δ10 3-stage whitelist** — `resolveStderrFilePath` MUST reject null byte,
 *    enforce realpath dir resolution, and apply `startsWith` dir prefix check
 * 3. **7d retention horizon** — `WorkerStderrConfig.retentionDays` default 7,
 *    min 1, max 30 (GDPR Art.5(1)(e) storage limitation contract)
 *
 * @see Plan v4.5 V3 §P0.5 (LCC-H-01 stderr PII sanitisation + 7d retention)
 * @see ADR-0036 §D4 (sanitizeStderrChunk independent design)
 * @see `.claude/rules/security.md` §"Canonical CWE-209 PII Protection Pattern"
 */

import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  resolveStderrFilePath,
  sanitizeStderrChunk,
  ensureStderrDir,
} from "../../../../src/utils/stderr-write-guard";
import {
  validateWorkerStderrEnv,
  __WORKER_STDERR_CONFIG_DEFAULTS_FOR_TEST,
} from "../../../../src/config/worker-stderr-config";

describe("INV-WORKER-STDERR-ISOLATION-001: stderr PII + Δ10 + 7d retention", () => {
  describe("Invariant 1: PII sanitisation enforcement (dedicated regex set — IO V0 Option A)", () => {
    // SEC-V45-PR1-H-NEW-1 structural fix (anchor `019e386a-58cf-7138`):
    // sanitizeStderrChunk MUST apply dedicated regex set independently of
    // sanitizeErrorMessage canonical SSOT, preserving stack-trace structure.

    it("redacts http(s) URLs to [REDACTED-URL]", () => {
      const raw = "ECONNREFUSED at https://internal.example.com/api/secret-endpoint";
      const sanitised = sanitizeStderrChunk(raw);
      expect(sanitised).not.toContain("internal.example.com");
      expect(sanitised).not.toContain("secret-endpoint");
      expect(sanitised).toContain("[REDACTED-URL]");
      // Stack-trace structure must remain observable.
      expect(sanitised).toContain("ECONNREFUSED");
    });

    it("redacts absolute POSIX paths to [REDACTED-PATH]", () => {
      const raw = "Failed to read <redacted-path> during startup";
      const sanitised = sanitizeStderrChunk(raw);
      expect(sanitised).not.toContain("<redacted-path>");
      expect(sanitised).toContain("[REDACTED-PATH]");
      // Surrounding diagnostic text must remain observable.
      expect(sanitised).toContain("Failed to read");
      expect(sanitised).toContain("during startup");
    });

    it("redacts Windows paths to [REDACTED-PATH]", () => {
      const raw = "Cannot access C:\\Users\\admin\\AppData\\secrets.json";
      const sanitised = sanitizeStderrChunk(raw);
      expect(sanitised).not.toContain("C:\\Users\\admin");
      expect(sanitised).not.toContain("secrets.json");
      expect(sanitised).toContain("[REDACTED-PATH]");
      expect(sanitised).toContain("Cannot access");
    });

    it("redacts PostgreSQL connection strings to [REDACTED-DB-CONNECTION]", () => {
      const raw =
        "Connection failed: postgresql://reftrix:secret@db.example:26432/reftrix at retry 3";
      const sanitised = sanitizeStderrChunk(raw);
      expect(sanitised).not.toContain("secret@db.example");
      expect(sanitised).not.toContain("postgresql://reftrix:secret");
      expect(sanitised).toContain("[REDACTED-DB-CONNECTION]");
      // Retry diagnostic must remain observable.
      expect(sanitised).toContain("Connection failed");
      expect(sanitised).toContain("at retry 3");
    });

    it("redacts long Base64 payloads (>=100 chars) to [REDACTED-BASE64]", () => {
      // 200-char Base64 simulating an embedding payload leak.
      const longBase64 = "A".repeat(150) + "BCDEF" + "G".repeat(45);
      const raw = `Embedding decode error: payload=${longBase64} truncated`;
      const sanitised = sanitizeStderrChunk(raw);
      expect(sanitised).not.toContain(longBase64);
      expect(sanitised).toContain("[REDACTED-BASE64]");
      // Diagnostic context must remain observable.
      expect(sanitised).toContain("Embedding decode error");
      expect(sanitised).toContain("truncated");
    });

    it("redacts JWT-like tokens to [REDACTED-JWT]", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      const raw = `Auth failed token=${jwt} status=401`;
      const sanitised = sanitizeStderrChunk(raw);
      expect(sanitised).not.toContain(jwt);
      expect(sanitised).toContain("[REDACTED-JWT]");
      expect(sanitised).toContain("Auth failed");
      expect(sanitised).toContain("status=401");
    });

    it("preserves short stack trace structure (observability — no full collapse)", () => {
      // Negative test: a typical Node.js stack trace WITHOUT secrets must
      // remain observable (file:line numbers redacted only as paths).
      const raw =
        "Error: oops\n    at fn (/app/dist/worker.js:42:13)\n    at processTicksAndRejections (node:internal/process/task_queues:96:5)";
      const sanitised = sanitizeStderrChunk(raw);
      // Error class name and message preserved.
      expect(sanitised).toContain("Error: oops");
      // Function names and "at" markers preserved.
      expect(sanitised).toContain("at fn");
      expect(sanitised).toContain("at processTicksAndRejections");
      // Path tokens redacted but stack structure intact.
      expect(sanitised).toContain("[REDACTED-PATH]");
      // Critical: must NOT collapse to canonical generic message.
      expect(sanitised).not.toBe("An internal error occurred");
    });

    it("empty content passes through unchanged (no-op short-circuit)", () => {
      expect(sanitizeStderrChunk("")).toBe("");
    });
  });

  describe("Invariant 2: Δ10 3-stage path traversal whitelist", () => {
    const stagingDir = path.join(os.tmpdir(), "reftrix-stderr-isolation-test");
    beforeAllOnce(stagingDir);

    it("Stage 1: rejects null byte in workerType", () => {
      // Null byte detection precedes charset check by order, so either error
      // message is acceptable for the "rejects null byte" contract.
      expect(() =>
        resolveStderrFilePath({ dir: stagingDir, workerType: "page\0", pid: 1234 })
      ).toThrow(/Null byte detected|Unsafe workerType identifier/);
    });

    it("Stage 1: rejects null byte in dir", () => {
      expect(() =>
        resolveStderrFilePath({
          dir: `${stagingDir}\0/evil`,
          workerType: "page",
          pid: 1234,
        })
      ).toThrow(/Null byte detected/);
    });

    it("Stage 1: rejects path traversal characters in workerType", () => {
      expect(() =>
        resolveStderrFilePath({
          dir: stagingDir,
          workerType: "../etc/passwd",
          pid: 1234,
        })
      ).toThrow(/Unsafe workerType identifier/);
    });

    it("Stage 1: rejects invalid pid (negative)", () => {
      expect(() => resolveStderrFilePath({ dir: stagingDir, workerType: "page", pid: -1 })).toThrow(
        /Invalid pid/
      );
    });

    it("Stage 2/3: accepts canonical path under configured dir", () => {
      const resolved = resolveStderrFilePath({
        dir: stagingDir,
        workerType: "page",
        pid: 12345,
      });
      expect(resolved).toContain("page-12345.log");
      expect(resolved.startsWith(fs.realpathSync(stagingDir))).toBe(true);
    });
  });

  describe("Invariant 3: 7d retention horizon (GDPR Art.5(1)(e))", () => {
    it("default retention is 7 days", () => {
      const cfg = validateWorkerStderrEnv({} as NodeJS.ProcessEnv);
      expect(cfg.retentionDays).toBe(
        __WORKER_STDERR_CONFIG_DEFAULTS_FOR_TEST.DEFAULT_RETENTION_DAYS
      );
      expect(cfg.retentionDays).toBe(7);
    });

    it("retention min boundary = 1 day", () => {
      const cfg = validateWorkerStderrEnv({
        REFTRIX_WORKER_STDERR_RETENTION_DAYS: "1",
      } as NodeJS.ProcessEnv);
      expect(cfg.retentionDays).toBe(1);
    });

    it("retention max boundary = 30 days", () => {
      const cfg = validateWorkerStderrEnv({
        REFTRIX_WORKER_STDERR_RETENTION_DAYS: "30",
      } as NodeJS.ProcessEnv);
      expect(cfg.retentionDays).toBe(30);
    });

    it("retention 31 days rejected (max enforcement)", () => {
      expect(() =>
        validateWorkerStderrEnv({
          REFTRIX_WORKER_STDERR_RETENTION_DAYS: "31",
        } as NodeJS.ProcessEnv)
      ).toThrow(/REFTRIX_WORKER_STDERR_RETENTION_DAYS/);
    });

    it("retention 0 rejected (min enforcement)", () => {
      expect(() =>
        validateWorkerStderrEnv({
          REFTRIX_WORKER_STDERR_RETENTION_DAYS: "0",
        } as NodeJS.ProcessEnv)
      ).toThrow(/REFTRIX_WORKER_STDERR_RETENTION_DAYS/);
    });
  });
});

function beforeAllOnce(dir: string): void {
  // Idempotent setup for Δ10 Stage 3 (real dir must exist for fs.realpathSync
  // to succeed without falling back to the resolved-only path).
  try {
    ensureStderrDir(dir);
  } catch {
    /* best-effort */
  }
}
