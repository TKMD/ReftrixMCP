// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Crash Report Sanitizer — General unit tests (Wave 3 PR3a)
 *
 * Plan v3 T2 V1 §7.1 unit tests #1-7 baseline coverage. PII-specific
 * regression coverage lives in `crash-report-sanitizer-pii-safety.test.ts`
 * (V1 §7.1 Δ2 #1-6 SEC sign-off evidence pack).
 *
 * @see Plan v3 T2 V1 §7.1 / §13.1 SEC sign-off evidence #2
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  sanitizeArgv,
  sanitizeArgvElement,
  sanitizeEnv,
  sanitizeHeapString,
  sanitizeReport,
  stripNonPublicNativeSymbols,
  normaliseStackFramePath,
  stripConnectionUrls,
  generateTruncatedReportId,
  buildAuditTargetIdForReport,
  resetRepoRootCacheForTesting,
  resetSequenceForTesting,
  REDACTED_VALUE,
  REDACTED_URL,
  REDACTED_UUID,
  REDACTED_NON_REPO_PATH,
  REDACTED_NATIVE_INTERNAL,
  AUDIT_LOG_CONSTANTS,
} from "../../src/services/crash-report-sanitizer";

describe("crash-report-sanitizer — argv sanitization", () => {
  it("redacts UUIDv4 boot tokens from argv elements", () => {
    const argv = ["node", "worker.js", "019e1263-f81a-7448-9334-0f2422f1982b"];
    const result = sanitizeArgv(argv);
    expect(result[2]).toBe(REDACTED_UUID);
  });

  it("redacts UUIDv7 boot tokens (timestamp prefix variant)", () => {
    const argv = ["worker", "0019b693-97fb-7620-8c76-828bd238a02f"];
    const result = sanitizeArgv(argv);
    expect(result[1]).toBe(REDACTED_UUID);
  });

  it("redacts URL arguments (https + http)", () => {
    const argv = ["worker", "--target=https://example.com/page", "--cdn=http://cdn.example.com"];
    const result = sanitizeArgv(argv);
    expect(result[1]).toContain(REDACTED_URL);
    expect(result[1]).not.toContain("example.com/page");
    expect(result[2]).toContain(REDACTED_URL);
  });

  it("preserves CLI flags and non-sensitive values", () => {
    const argv = ["node", "worker.js", "--page", "--backfill", "--verbose"];
    const result = sanitizeArgv(argv);
    expect(result).toEqual(argv);
  });

  it("returns empty array for non-array input", () => {
    expect(sanitizeArgv(undefined as unknown as readonly string[])).toEqual([]);
  });

  it("sanitizes a single argv element via sanitizeArgvElement", () => {
    expect(sanitizeArgvElement("https://example.com")).toBe(REDACTED_URL);
    expect(sanitizeArgvElement("--page")).toBe("--page");
  });
});

describe("crash-report-sanitizer — env sanitization (SSOT pattern)", () => {
  it("redacts DATABASE_URL", () => {
    const env = { DATABASE_URL: "postgres://user:pass@host:5432/db", PORT: "26432" };
    const result = sanitizeEnv(env);
    expect(result.DATABASE_URL).toBe(REDACTED_VALUE);
    expect(result.PORT).toBe("26432");
  });

  it("redacts REDIS_PASSWORD via password substring match", () => {
    const env = { REDIS_PASSWORD: "supersecret" };
    const result = sanitizeEnv(env);
    expect(result.REDIS_PASSWORD).toBe(REDACTED_VALUE);
  });

  it("redacts OPENAI_API_KEY via api_key substring match", () => {
    const env = { OPENAI_API_KEY: "sk-1234567890abcdef" };
    const result = sanitizeEnv(env);
    expect(result.OPENAI_API_KEY).toBe(REDACTED_VALUE);
  });

  it("preserves Reftrix non-sensitive env vars", () => {
    const env = {
      NODE_ENV: "production",
      REFTRIX_SCREENSHOT_ROOT: "/tmp/reftrix-screenshots",
      REFTRIX_CRASH_DUMP_ROOT: "/tmp/reftrix-crashes",
    };
    const result = sanitizeEnv(env);
    expect(result.NODE_ENV).toBe("production");
    expect(result.REFTRIX_SCREENSHOT_ROOT).toBe("/tmp/reftrix-screenshots");
    expect(result.REFTRIX_CRASH_DUMP_ROOT).toBe("/tmp/reftrix-crashes");
  });

  it("skips undefined env values", () => {
    const env: Record<string, string | undefined> = { DEFINED: "value", UNDEFINED: undefined };
    const result = sanitizeEnv(env);
    expect(result.DEFINED).toBe("value");
    expect(result.UNDEFINED).toBeUndefined();
  });

  it("strips embedded connection URLs from non-sensitive env values", () => {
    // PATH-like env that incidentally contains a connection string
    // (defense-in-depth — should not happen normally, but if a tool surfaces it).
    const env = { CUSTOM_VAR: "prefix postgres://leaked@host/db suffix" };
    const result = sanitizeEnv(env);
    expect(result.CUSTOM_VAR).not.toContain("postgres://");
    expect(result.CUSTOM_VAR).toContain(REDACTED_URL);
  });

  it("returns empty object for non-object input", () => {
    expect(sanitizeEnv(undefined as unknown as Record<string, string>)).toEqual({});
  });
});

describe("crash-report-sanitizer — native stack symbol stripping (Δ9)", () => {
  it("redacts __libc_ internal symbols", () => {
    expect(stripNonPublicNativeSymbols("__libc_malloc")).toBe(REDACTED_NATIVE_INTERNAL);
    expect(stripNonPublicNativeSymbols("__libc_free")).toBe(REDACTED_NATIVE_INTERNAL);
  });

  it("redacts vips_internal_ symbols", () => {
    expect(stripNonPublicNativeSymbols("vips_internal_buffer")).toBe(REDACTED_NATIVE_INTERNAL);
  });

  it("preserves public API symbols", () => {
    expect(stripNonPublicNativeSymbols("ONNXSession::Run")).toBe("ONNXSession::Run");
    expect(stripNonPublicNativeSymbols("abort")).toBe("abort");
    expect(stripNonPublicNativeSymbols("Sharp::pipeline")).toBe("Sharp::pipeline");
  });

  it("returns input unchanged for non-string or empty", () => {
    expect(stripNonPublicNativeSymbols("")).toBe("");
    expect(stripNonPublicNativeSymbols(undefined as unknown as string)).toBe(undefined);
  });
});

describe("crash-report-sanitizer — JS stack frame path normalisation", () => {
  beforeEach(() => {
    resetRepoRootCacheForTesting();
    // Force repo root to a deterministic value for test reproducibility.
    process.env.REFTRIX_REPO_ROOT = "/home/test/Reftrix";
  });

  it("normalises in-repo paths to relative form", () => {
    const result = normaliseStackFramePath("/home/test/Reftrix/apps/mcp-server/src/x.ts");
    expect(result).toBe("apps/mcp-server/src/x.ts");
  });

  it("redacts out-of-repo paths", () => {
    const result = normaliseStackFramePath("/home/test/secrets/.env");
    expect(result).toBe(REDACTED_NON_REPO_PATH);
  });

  it("redacts arbitrary system paths", () => {
    const result = normaliseStackFramePath("/etc/passwd");
    expect(result).toBe(REDACTED_NON_REPO_PATH);
  });

  it("redacts node: built-in module URIs (treated as non-repo paths)", () => {
    // `node:fs/promises` contains a path separator (`/`), so the function
    // attempts path resolution. Since `node:` URIs are not absolute repo
    // paths, they resolve outside the repo root and get redacted. This is
    // the correct, defense-in-depth behaviour: ANY path-like string outside
    // the repo root is treated as potentially-PII-bearing and redacted.
    expect(normaliseStackFramePath("node:fs/promises")).toBe(REDACTED_NON_REPO_PATH);
  });

  it("passes through truly-no-separator strings unchanged", () => {
    expect(normaliseStackFramePath("anonymous")).toBe("anonymous");
    expect(normaliseStackFramePath("FunctionName")).toBe("FunctionName");
  });
});

describe("crash-report-sanitizer — heap string sanitization (Δ2 #5 + Δ5)", () => {
  it("strips embedded postgres URLs from heap strings", () => {
    const value = "Connection failed: postgres://user:pw@host:5432/db";
    const result = sanitizeHeapString(value);
    expect(result).not.toContain("postgres://");
    expect(result).toContain(REDACTED_URL);
  });

  it("strips embedded redis URLs from heap strings", () => {
    const value = "redis://localhost:6379/0";
    const result = sanitizeHeapString(value);
    expect(result).not.toContain("redis://");
  });

  it("redacts UUIDs from heap strings", () => {
    const value = "token=019e1263-f81a-7448-9334-0f2422f1982b";
    const result = sanitizeHeapString(value);
    expect(result).toContain(REDACTED_UUID);
    expect(result).not.toContain("019e1263-f81a");
  });

  it("preserves benign strings unchanged", () => {
    const value = "Normal log message without PII";
    expect(sanitizeHeapString(value)).toBe(value);
  });

  it("handles empty strings safely", () => {
    expect(sanitizeHeapString("")).toBe("");
  });
});

describe("crash-report-sanitizer — connection URL stripping", () => {
  it("strips mongodb URLs", () => {
    const result = stripConnectionUrls("Failed: mongodb://leaked@host/db");
    expect(result).not.toContain("mongodb://");
    expect(result).toContain(REDACTED_URL);
  });

  it("strips mongodb+srv URLs", () => {
    const result = stripConnectionUrls("mongodb+srv://cluster.example.com/db");
    expect(result).not.toContain("mongodb+srv://");
  });

  it("preserves strings without connection URLs", () => {
    expect(stripConnectionUrls("plain text")).toBe("plain text");
  });
});

describe("crash-report-sanitizer — sanitizeReport happy path", () => {
  beforeEach(() => {
    resetSequenceForTesting();
    resetRepoRootCacheForTesting();
    process.env.REFTRIX_REPO_ROOT = "/home/test/Reftrix";
  });

  it("returns sanitizationApplied=true on a well-formed report", () => {
    const rawReport = {
      header: {
        commandLine: ["node", "worker.js", "https://example.com"],
        cwd: "/home/test/Reftrix/apps/mcp-server",
      },
      environmentVariables: {
        NODE_ENV: "production",
        DATABASE_URL: "postgres://secret",
      },
      javascriptStack: {
        message: "Connection failed: postgres://leak",
        stack: ["at handler (/home/test/Reftrix/apps/mcp-server/src/x.ts:10:5)"],
      },
      nativeStack: ["__libc_malloc", "ONNXSession::Run"],
      javascriptHeap: { totalMemory: 12345 },
    };
    const result = sanitizeReport(rawReport);
    expect(result.sanitizationApplied).toBe(true);
    expect(result.sanitizationDurationMs).toBeGreaterThanOrEqual(0);
    const r = result.report as Record<string, unknown>;
    const header = r.header as Record<string, unknown>;
    expect((header.commandLine as string[])[2]).toBe(REDACTED_URL);
    const env = r.environmentVariables as Record<string, string>;
    expect(env.NODE_ENV).toBe("production");
    expect(env.DATABASE_URL).toBe(REDACTED_VALUE);
    const jsStack = r.javascriptStack as Record<string, unknown>;
    expect(jsStack.message as string).not.toContain("postgres://");
    expect((jsStack.stack as string[])[0]).toContain("apps/mcp-server/src/x.ts");
    const nativeStack = r.nativeStack as string[];
    expect(nativeStack[0]).toBe(REDACTED_NATIVE_INTERNAL);
    expect(nativeStack[1]).toBe("ONNXSession::Run");
  });

  it("extracts jsStackTopFrame for audit emit", () => {
    const rawReport = {
      javascriptStack: {
        stack: ["at frame1", "at frame2"],
      },
    };
    const result = sanitizeReport(rawReport);
    expect(result.jsStackTopFrame).toBe("at frame1");
  });

  it("extracts nativeStackTopSymbol for audit emit", () => {
    const rawReport = {
      nativeStack: ["ONNXSession::Run", "__libc_malloc"],
    };
    const result = sanitizeReport(rawReport);
    expect(result.nativeStackTopSymbol).toBe("ONNXSession::Run");
  });

  it("handles non-object input as no-op", () => {
    const result = sanitizeReport("not an object");
    expect(result.sanitizationApplied).toBe(true);
    expect(result.report).toBe("not an object");
  });

  it("handles null input as no-op", () => {
    const result = sanitizeReport(null);
    expect(result.sanitizationApplied).toBe(true);
    expect(result.report).toBe(null);
  });
});

describe("crash-report-sanitizer — truncated report ID generation (Δ11)", () => {
  beforeEach(() => {
    resetSequenceForTesting();
  });

  it("generates report ID without pid (3-segment form report.<bucket>.<seq>)", () => {
    const id = generateTruncatedReportId(new Date(1715472000000));
    // Δ11 contract: exactly 3 dot-separated segments — "report" / <bucket> / <seq>
    const segments = id.split(".");
    expect(segments).toHaveLength(3);
    expect(segments[0]).toBe("report");
    // Bucket = floor(unix_seconds / 60) * 60 → 1715472000 (already on a 1-min boundary)
    expect(segments[1]).toBe("1715472000");
    // Seq = process-local monotonic, starts at 1 after reset
    expect(segments[2]).toBe("1");
    // PID is a 4-6 digit number on Linux. The seq starts at 1 and grows
    // monotonically per process — after only a single emit it is "1", which is
    // structurally distinct from a pid. Hard assertion: the last segment must
    // match the sequence counter, not a pid.
    expect(segments[2]).not.toMatch(/^\d{4,}$/);
  });

  it("buckets timestamps to 1-min granularity", () => {
    const id1 = generateTruncatedReportId(new Date(1715472000000));
    const id2 = generateTruncatedReportId(new Date(1715472030000)); // +30s
    // Both should share the same bucketSec (floor(unix/60)*60).
    const seg1 = id1.split(".")[1];
    const seg2 = id2.split(".")[1];
    expect(seg1).toBe(seg2);
  });

  it("buildAuditTargetIdForReport applies SSOT truncation", () => {
    const truncated = "report.1715472000.1";
    const target = buildAuditTargetIdForReport(truncated);
    // SSOT length = 8 → "report.1" + "..."
    expect(target).toMatch(
      new RegExp(`^.{${AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH}}\\.\\.\\.$`)
    );
  });

  it("returns null for empty target id", () => {
    expect(buildAuditTargetIdForReport("")).toBe(null);
  });
});
