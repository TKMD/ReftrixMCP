// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-MCP-PROGRESS-ASYNC-001: page.analyze async path MUST NOT emit MCP
 * `notifications/progress` after enqueue response (MCP spec 2025-06-18 +
 * 2025-11-25 "Progress notifications MUST stop after completion" violation
 * prevention).
 *
 * Background:
 *   `apps/mcp-server/src/tools/page/analyze.tool.ts` async path previously
 *   contained a `void progressService.notifyPhaseStart("ingest")` call
 *   immediately before the async response return. This created a race
 *   condition (CWE-662 Improper Synchronization): the fire-and-forget
 *   notification may be delivered to the MCP client *after* the response
 *   completes. Per MCP spec 2025-06-18 + 2025-11-25, the response return
 *   marks the request lifecycle as completed, so any subsequent progress
 *   notification references an "unknown token" — the SDK then drops the
 *   STDIO transport, killing both the MCP server and the spawned worker
 *   child (cascade kill via parent stdin close).
 *
 * Hybrid test design (Plan v1.0 §4.3 + Registry C5):
 *   - Block A (AST source-pin): static analysis ensures no
 *     `progressService.notifyPhase*` call exists in the async-return
 *     lookback window. Deterministic CI-failing guard against future
 *     regressions (PR-D-5 Block A "AST source-pin" precedent).
 *   - Block B (runtime integration): vi.spyOn on the inject-mockable
 *     `sendNotification` function (passed via `progressContext`) to assert
 *     no progress notifications are emitted before/at async return time.
 *
 * @see Plan v1.0 §4 (`
 * @see Finding Registry v1 §2.2 EFF-H-01 / EFF-M-02 / EFF-M-03 (`
 * @see ADR-0011 (Worker Dual-run Lock) — context for cascade kill behavior
 * @see CWE-662 (Improper Synchronization, primary)
 * @see CWE-755 (Improper Handling of Exceptional Conditions, secondary)
 *
 * @module tests/tools/page/analyze-async-no-progress
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import {
  addMcpServerSourceFile,
  createAstProject,
} from "../../regression/standing/schema-enum-sync/_extractors";
import { assertInvName } from "../../regression/standing/_setup/inv-assert";

// ============================================================================
// Block A — AST source-pin (deterministic CI-failing contract)
// ============================================================================
//
// Heuristic: scan a 1500-byte lookback window upstream of the async-return
// statement (`return asyncResponse as unknown as PageAnalyzeOutput;`) for any
// `progressService.notifyPhase*(...)` invocation. This window is sized to
// cover the entire async-mode try-block body (Phase 1 through enqueue +
// response construction, currently ~370 bytes; margin for future additions).
const LOOKBACK_BYTES = 1500;

describe("INV-MCP-PROGRESS-ASYNC-001: async path no-progress contract", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-MCP-PROGRESS-ASYNC-001");
  });

  describe("Block A: AST source-pin", () => {
    it("INV-MCP-PROGRESS-ASYNC-001: A1 — analyze.tool.ts MUST NOT call progressService.notifyPhase* before async return", () => {
      // T1 Canonical: source-file static analysis enforces the contract.
      // Rationale: runtime mocks may miss timing-dependent emissions, but
      // source-pattern presence vs absence is deterministic.
      const project = createAstProject();
      const sourceFile = addMcpServerSourceFile(project, "src/tools/page/analyze.tool.ts");
      const source = sourceFile.getFullText();

      // Locate async return path: `return asyncResponse as unknown as PageAnalyzeOutput;`
      const asyncReturnIdx = source.indexOf("return asyncResponse as unknown as PageAnalyzeOutput");
      expect(
        asyncReturnIdx,
        "async return path not found in analyze.tool.ts — test invariant precondition violated"
      ).toBeGreaterThan(0);

      // Carve out a lookback window of `LOOKBACK_BYTES` bytes upstream.
      // Snap to line boundaries for readable failure messages.
      const lookbackStart = source.lastIndexOf("\n", asyncReturnIdx - 1);
      const sliceStart = Math.max(0, source.lastIndexOf("\n", lookbackStart - LOOKBACK_BYTES));
      const lookback = source.slice(sliceStart, asyncReturnIdx);

      // Sanity check (per Plan EFF-L-01 / TPA-PLAN-04): the lookback window
      // must contain meaningful content. A < 500-byte window indicates
      // either source restructuring or test-internal slicing logic bug.
      expect(
        lookback.length,
        `Lookback window too small (${lookback.length} bytes < 500). Source may have been restructured; revisit LOOKBACK_BYTES sizing.`
      ).toBeGreaterThan(500);

      // Core assertion: no progressService.notifyPhase* calls in lookback.
      expect(
        lookback,
        "INV-MCP-PROGRESS-ASYNC-001 violation: progressService.notifyPhase* call found before async return path. " +
          "MCP spec 2025-06-18 + 2025-11-25: 'Progress notifications MUST stop after completion'. " +
          "Async response return marks request lifecycle complete; subsequent progress emissions reference an unknown token, " +
          "causing MCP STDIO transport drop and cascade kill (CWE-662 Improper Synchronization). " +
          "Use page.getJobStatus polling for async progress (line 510-515 of analyze.tool.ts)."
      ).not.toMatch(/progressService\.notifyPhase\w+\s*\(/);
    });
  });
});

// ============================================================================
// Block B — Runtime integration test (behavioral verification)
// ============================================================================
//
// Mocks all async-path external dependencies (Redis / queue / worker /
// cleanup) so we can drive `pageAnalyzeHandler` to the async-return path
// without spawning real infrastructure. The injected `progressContext`
// carries a vi.fn() spy as `sendNotification` — `ProgressNotificationService`
// (constructed locally inside the handler at L254) routes its `notifyPhase*`
// calls through this exact spy via the `progressContext.sendNotification`
// closure (line 256-260 of analyze.tool.ts). Therefore observing the spy is
// equivalent to observing whether the handler invoked any `notifyPhase*`
// before returning.
//
// IMPORTANT (mock declaration order): vi.mock calls are hoisted. Mocks must
// be declared BEFORE the handler import below.

vi.mock("../../../src/config/redis", () => ({
  isRedisAvailable: vi.fn(),
}));

vi.mock("../../../src/queues/page-analyze-queue", () => ({
  createPageAnalyzeQueue: vi.fn(),
  addPageAnalyzeJobWithGuard: vi.fn(),
  closeQueue: vi.fn(),
}));

vi.mock("../../../src/services/worker-supervisor.service", () => ({
  getWorkerSupervisor: vi.fn(),
}));

vi.mock("../../../src/services/queue-cleanup.service", () => ({
  cleanupQueue: vi.fn(),
  createQueueAdapter: vi.fn(),
}));

vi.mock("../../../src/utils/url-validator", () => ({
  validateExternalUrl: vi.fn(),
  normalizeUrlForValidation: vi.fn((url: string) => url),
}));

vi.mock("@reftrixmcp/core", async (importOriginal) => {
  // Partial mock: keep `ROBOTS_TXT` constants and other exports intact
  // (used by `responsive/shared-browser-manager.ts` etc.) while
  // overriding the network-touching `isUrlAllowedByRobotsTxt`.
  const actual = await importOriginal<typeof import("@reftrixmcp/core")>();
  return {
    ...actual,
    isUrlAllowedByRobotsTxt: vi.fn().mockResolvedValue({ allowed: true }),
  };
});

vi.mock("../../../src/utils/logger", async (importOriginal) => {
  // Partial mock: keep `Logger` class export (used by other services like
  // `persistent-cache.ts`) intact while silencing the singleton `logger`
  // and forcing `isDevelopment()` to false for deterministic test logs.
  const actual = await importOriginal<typeof import("../../../src/utils/logger")>();
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    isDevelopment: vi.fn(() => false),
  };
});

import { isRedisAvailable } from "../../../src/config/redis";
import {
  createPageAnalyzeQueue,
  addPageAnalyzeJobWithGuard,
} from "../../../src/queues/page-analyze-queue";
import { getWorkerSupervisor } from "../../../src/services/worker-supervisor.service";
import { cleanupQueue, createQueueAdapter } from "../../../src/services/queue-cleanup.service";
import { validateExternalUrl } from "../../../src/utils/url-validator";
import { pageAnalyzeHandler } from "../../../src/tools/page/analyze.tool";
import type { ProgressContext } from "../../../src/router";

describe("INV-MCP-PROGRESS-ASYNC-001: async path runtime integration", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-MCP-PROGRESS-ASYNC-001");

    vi.clearAllMocks();

    // Default: Redis available, async path enterable.
    (isRedisAvailable as Mock).mockResolvedValue(true);
    (createPageAnalyzeQueue as Mock).mockReturnValue({
      getJob: vi.fn(),
      close: vi.fn(),
    });
    (getWorkerSupervisor as Mock).mockReturnValue({
      ensureWorkerRunning: vi.fn(),
      // PR-D-9 Wave 1 (C-11): bootstrapWorkersForPageAnalyze defaults to
      // staggered spawn; add mock to satisfy the new helper's call surface.
      // PR-D-9 Wave 1 (C-11): bootstrapWorkersForPageAnalyze はデフォルトで
      // staggered spawn を呼ぶため新 helper の call surface に合わせ mock 追加。
      ensureAllWorkersRunningStaggered: vi.fn().mockResolvedValue(undefined),
    });
    (cleanupQueue as Mock).mockResolvedValue({
      strategy: "skipped",
      totalCleaned: 0,
    });
    (createQueueAdapter as Mock).mockReturnValue({});
    (validateExternalUrl as Mock).mockReturnValue({
      valid: true,
      normalizedUrl: "https://example.com",
    });
    (addPageAnalyzeJobWithGuard as Mock).mockResolvedValue({
      outcome: "enqueued_new",
      jobId: "test-job-id-001",
      collision: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("INV-MCP-PROGRESS-ASYNC-001: B1 — async path MUST NOT invoke sendNotification before returning async response", async () => {
    // CWE-662 runtime defense: ProgressNotificationService at analyze.tool.ts:254
    // is constructed with this exact `sendNotification` spy. Any internal
    // `notifyPhase*` call would invoke `sendNotification(notification)` —
    // observing zero invocations proves the contract.
    const sendNotificationSpy = vi.fn().mockResolvedValue(undefined);

    const progressContext: ProgressContext = {
      // integer literal — protocol-level token, not PII (request scope only)
      progressToken: 42, // any non-undefined token activates the service
      sendNotification: sendNotificationSpy,
    };

    const result = await pageAnalyzeHandler(
      {
        url: "https://example.com",
        async: true,
      },
      progressContext
    );

    // Allow microtask queue to drain — if a `void notifyPhaseStart(...)` call
    // were still in the source, its inner `await sendNotification(...)` would
    // resolve in a subsequent microtask. 100ms is overkill for an in-process
    // mock but matches the Plan EFF-M-02 / Registry C5 "100ms wait" contract.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Primary assertion: no MCP progress notifications emitted before async return.
    expect(
      sendNotificationSpy,
      "INV-MCP-PROGRESS-ASYNC-001 runtime violation: sendNotification was invoked before async return. " +
        "This emits an MCP `notifications/progress` referencing a token that the client has already discarded " +
        "(MCP SDK handler delete on response, shared/protocol.js:475-477), causing STDIO transport drop and " +
        "cascade kill of the worker child (CWE-662)."
    ).not.toHaveBeenCalled();

    // Sanity: confirm we actually reached the async return path (not an
    // early exit), so the absence of progress emission is meaningful.
    expect(
      result,
      "Test precondition: async path must return an async-shaped response"
    ).toMatchObject({ async: true, status: "queued" });
  });
});
