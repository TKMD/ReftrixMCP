// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-SEC-BROWSER-MISSING-FIXED-MESSAGE-001 経路テスト / route tests
 * adapter → layout.ingest / page.analyze sync / worker Phase 0 の client 文言。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const RAW =
  "browserType.launch: Executable doesn't exist at /home/u/.cache/ms-playwright/chromium_headless_shell-1200/x\n" +
  "║     npx playwright install                                              ║";

const { mockLaunch } = vi.hoisted(() => ({ mockLaunch: vi.fn() }));

vi.mock("playwright", () => ({ chromium: { launch: mockLaunch } }));
vi.mock("../../src/utils/url-validator", () => ({
  validateExternalUrl: vi
    .fn()
    .mockReturnValue({ valid: true, normalizedUrl: "https://example.com" }),
  BLOCKED_HOSTS: [],
  BLOCKED_IP_RANGES: [],
}));
// page.analyze sync: pre-fetch probes would touch the network
vi.mock("../../src/tools/page/handlers/sync-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/tools/page/handlers/sync-helpers")>();
  return {
    ...actual,
    computePreFetchConfig: vi.fn().mockResolvedValue({
      preDetection: { isLikelyWebGL: false, timeoutMultiplier: 1 },
      preAdjustedTimeout: 30000,
      probeResult: null,
      finalBaseTimeout: 30000,
    }),
  };
});
vi.mock("../../src/utils/html-sanitizer", () => ({ sanitizeHtml: (h: string) => h }));

import { logger } from "../../src/utils/logger";
import { BROWSER_MISSING_MESSAGE } from "../../src/utils/browser-missing";
import { pageIngestAdapter } from "../../src/services/page-ingest-adapter";
import { layoutIngestHandler } from "../../src/tools/layout/ingest.tool";
import { executeSyncProcessing } from "../../src/tools/page/handlers/sync-processing";
import { pageAnalyzeInputSchema } from "../../src/tools/page/schemas";
import { processIngestPhase } from "../../src/workers/phases/phase-0-ingest";

const LEAK = [/\/home\//, /ms-playwright/, /\.cache/, /Call log:/, /║/];
function expectFixed(s: unknown): void {
  expect(s).toBe(BROWSER_MISSING_MESSAGE);
  for (const re of LEAK) expect(String(s)).not.toMatch(re);
}

let mockWarn: ReturnType<typeof vi.spyOn>;

describe("browser-missing client routes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockLaunch.mockReset();
    mockWarn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    mockLaunch.mockRejectedValue(new Error(RAW));
  });

  it("adapter.ingest returns the fixed message and keeps raw in the server-side log", async () => {
    const r = await pageIngestAdapter.ingest({
      url: "https://example.com",
      respectRobotsTxt: false,
    });
    expect(r.success).toBe(false);
    expectFixed(r.error);
    const logged = JSON.stringify(mockWarn.mock.calls);
    expect(logged).toContain("ms-playwright");
  });

  it("layout.ingest exposes only the fixed message", async () => {
    const r = (await layoutIngestHandler({
      url: "https://example.com",
      options: { respect_robots_txt: false },
    })) as { success: boolean; error?: { message: string } };
    expect(r.success).toBe(false);
    expectFixed(r.error?.message);
  });

  it("page.analyze sync starts with the fixed message; only the ' (after N attempt(s))' suffix is allowed", async () => {
    const validated = pageAnalyzeInputSchema.parse({
      url: "https://example.com",
      async: false,
      timeout: 5000,
    });
    const r = await executeSyncProcessing(validated, "https://example.com", Date.now(), {
      getService: () => ({}),
      getPrismaClient: () => null,
    });
    expect(r.success).toBe(false);
    const message = (r as { error: { message: string } }).error.message;
    expect(message.startsWith(BROWSER_MISSING_MESSAGE)).toBe(true);
    const suffix = message.slice(BROWSER_MISSING_MESSAGE.length);
    expect(suffix === "" || /^ \(after \d+ attempts?\)$/.test(suffix)).toBe(true);
    for (const re of LEAK) expect(message).not.toMatch(re);
  }, 60_000);

  it("worker Phase 0 (processIngestPhase) throws exactly the fixed message (failedReason source)", async () => {
    const job = { updateProgress: vi.fn(), log: vi.fn() };
    const statusTracker = { startPhase: vi.fn(), completePhase: vi.fn() };
    const ctx = {
      job,
      options: {},
      url: "https://example.com",
      webPageId: "00000000-0000-4000-8000-000000000000",
      effectiveToken: "t",
      effectiveLockDuration: 1000,
      statusTracker,
    };
    const deps = {
      pageIngestAdapter: pageIngestAdapter as never,
      prisma: { webPage: { upsert: vi.fn() } },
      screenshotPersistenceService: {} as never,
    };
    let caught: unknown;
    try {
      await processIngestPhase({ completedPhases: [] } as never, ctx as never, deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expectFixed((caught as Error).message);
  });
});
