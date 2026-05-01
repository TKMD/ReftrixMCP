// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WorkerSupervisor sanitize SSOT regression (PR-D-8 Phase 2 MF-09)
 *
 * MF-09 / SEC-IMPL-05 contract: WorkerSupervisor's `child.on("error", ...)`
 * handler MUST route the raw `error` object through `sanitizeErrorMessage()`
 * before logging. CWE-209 (Information Exposure Through an Error Message)
 * defense — Prisma error codes / DB column names / SQL fragments must NEVER
 * appear in client-visible log channels.
 *
 * MF-09 / SEC-IMPL-05 契約: WorkerSupervisor の `child.on("error", ...)` は
 * `sanitizeErrorMessage()` 経由で error を sanitize してから logger.error に
 * 渡すこと。CWE-209 (Information Exposure Through an Error Message) 対策。
 *
 * @module tests/services/worker-supervisor-sanitize
 * @see PR-D-8 Plan v1.1 §3.2.6 MF-09
 * @see CWE-209 / sanitize-error.ts SSOT
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// ============================================================================
// hoisted mocks (vi.mock runs before imports)
// ============================================================================

const mockFork = vi.fn();
vi.mock("node:child_process", () => ({
  fork: (...args: unknown[]) => mockFork(...args),
}));

vi.mock("../../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

// ============================================================================
// helpers
// ============================================================================

function createMockChildProcess(pid: number): ChildProcess & EventEmitter {
  const emitter = new EventEmitter();
  const mockProcess = Object.assign(emitter, {
    pid,
    kill: vi.fn().mockReturnValue(true),
    connected: true,
    send: vi.fn().mockReturnValue(true),
    disconnect: vi.fn(),
    unref: vi.fn(),
    ref: vi.fn(),
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    spawnargs: [] as string[],
    spawnfile: "",
    stdio: [null, null, null, null, null] as ChildProcess["stdio"],
    stdin: null,
    stdout: null,
    stderr: null,
    channel: undefined,
    [Symbol.dispose]: vi.fn(),
  }) as unknown as ChildProcess & EventEmitter;
  return mockProcess;
}

// ============================================================================
// suite
// ============================================================================

describe("WorkerSupervisor sanitize SSOT (PR-D-8 Phase 2 MF-09 / SEC-IMPL-05)", () => {
  let mockChild: ChildProcess & EventEmitter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = createMockChildProcess(13579);
    mockFork.mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("MF-09: child.on('error', ...) routes Prisma-like error through sanitizeErrorMessage (raw DB column names redacted) / Prisma 系 error は sanitize 経由で client log に渡る", async () => {
    // Setup: supervisor with mocked fork. After ensureWorkerRunning, the
    // supervisor attaches a `child.on("error", (error) => logger.error(...))`
    // handler at L820-L830 of worker-supervisor.service.ts.
    //
    // Setup: mocked fork で supervisor 起動。`child.on("error", ...)` ハンドラが
    // attach される。
    const { WorkerSupervisor } = await import("../../src/services/worker-supervisor.service");
    const { logger } = await import("../../src/utils/logger");

    const supervisor = new WorkerSupervisor({
      workerScript: "./dist/scripts/start-workers.js",
      maxJobsBeforeRestart: 5,
      maxRestartAttempts: 3,
      shutdownTimeoutMs: 10000,
    });
    supervisor.ensureWorkerRunning();
    expect(mockFork).toHaveBeenCalledTimes(1);

    // Construct a Prisma-like error containing DB schema details that MUST
    // NOT leak to the log payload. Real Prisma errors carry `code` (P2002,
    // P2025, ...) and a message that often references table/column names.
    //
    // CWE-209 defense target: P2002 message "Unique constraint failed on
    // the constraint: web_pages_url_key" includes the table name and
    // constraint name — both are internal DB schema details.
    //
    // CWE-209 防御対象: Prisma P2002 message に table/constraint 名が含まれる。
    const prismaError = new Error(
      'Unique constraint failed on the constraint: "web_pages_url_key"'
    );
    (prismaError as { code?: string }).code = "P2002";

    // Trigger the error handler via the EventEmitter.
    // EventEmitter 経由で error handler を起動。
    mockChild.emit("error", prismaError);

    // Assert: logger.error was called with `error` field NOT containing the
    // raw message (table name leakage). `sanitizeErrorMessage` maps P2002 to
    // "A record with this value already exists" (PRISMA_ERROR_MESSAGES).
    //
    // assert: logger.error の `error` field に raw message (table 名) が
    // 含まれない。P2002 は sanitize で固定文字列にマップされる。
    expect(logger.error).toHaveBeenCalled();
    const loggerErrorCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls;
    const matchedCall = loggerErrorCalls.find(
      ([msg]: [unknown]) =>
        typeof msg === "string" && msg.includes("[WorkerSupervisor] Worker process error")
    );
    expect(matchedCall, "supervisor must log on child error").toBeDefined();
    const [, payload] = matchedCall!;
    expect(payload).toBeDefined();
    const errorField = (payload as Record<string, unknown>).error;
    expect(typeof errorField).toBe("string");
    // sanitized P2002 mapping
    expect(errorField).toBe("A record with this value already exists");
    // raw message must NOT leak
    expect(errorField).not.toContain("web_pages_url_key");
    expect(errorField).not.toContain("Unique constraint");
  });

  it("MF-09: generic Error message is generalized via sanitizeErrorMessage (NO raw stack / message in client log) / 一般 Error も sanitize 経由で汎用化", async () => {
    const { WorkerSupervisor } = await import("../../src/services/worker-supervisor.service");
    const { logger } = await import("../../src/utils/logger");

    const supervisor = new WorkerSupervisor({
      workerScript: "./dist/scripts/start-workers.js",
      maxJobsBeforeRestart: 5,
      maxRestartAttempts: 3,
      shutdownTimeoutMs: 10000,
    });
    supervisor.ensureWorkerRunning();

    // Generic error with a message that mimics internal stack hints.
    // 内部スタックヒントを含む generic error。
    const internalError = new Error(
      "InternalServerError: failed to load apps/mcp-server/src/secret/path"
    );
    mockChild.emit("error", internalError);

    expect(logger.error).toHaveBeenCalled();
    const loggerErrorCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls;
    const matchedCall = loggerErrorCalls.find(
      ([msg]: [unknown]) =>
        typeof msg === "string" && msg.includes("[WorkerSupervisor] Worker process error")
    );
    expect(matchedCall).toBeDefined();
    const [, payload] = matchedCall!;
    const errorField = (payload as Record<string, unknown>).error;
    // sanitized to generic category — never the raw message containing the
    // file path. Generic errors with no Prisma code / network keyword fall
    // to "An internal error occurred".
    // sanitize 後は汎用 internal error message。raw path は含まれない。
    expect(errorField).toBe("An internal error occurred");
    expect(errorField).not.toContain("
    expect(errorField).not.toContain("secret/path");
    expect(errorField).not.toContain("InternalServerError");
  });

  it("MF-09: child.on('error', ...) preserves workerType + pid as structured context / sanitize 後も workerType + pid は保持される", async () => {
    // The sanitize SSOT must NOT strip non-PII structured fields. workerType
    // and pid are observability fields that MUST remain in the log payload.
    //
    // sanitize SSOT は workerType / pid のような observability field を残す。
    const { WorkerSupervisor } = await import("../../src/services/worker-supervisor.service");
    const { logger } = await import("../../src/utils/logger");

    const supervisor = new WorkerSupervisor({
      workerScript: "./dist/scripts/start-workers.js",
      maxJobsBeforeRestart: 5,
      maxRestartAttempts: 3,
      shutdownTimeoutMs: 10000,
    });
    supervisor.ensureWorkerRunning();

    mockChild.emit("error", new Error("dummy"));

    const loggerErrorCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls;
    const matchedCall = loggerErrorCalls.find(
      ([msg]: [unknown]) =>
        typeof msg === "string" && msg.includes("[WorkerSupervisor] Worker process error")
    );
    expect(matchedCall).toBeDefined();
    const [, payload] = matchedCall!;
    const ctx = payload as Record<string, unknown>;
    expect(ctx.workerType).toBe("page");
    expect(ctx.pid).toBe(13579);
  });
});
