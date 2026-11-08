// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-ROBOTS-URL-TOOLS-001
 *
 * URL を受け取って第三者のページを開く motion.detect / accessibility.audit /
 * performance.evaluate / responsive.capture は、ページを開く前に robots.txt を
 * `ReftrixBot` のトークンで確認し、拒否されたら `ROBOTS_TXT_BLOCKED` で返す（ブラウザを起動しない）。
 * 確認は `REFTRIX_RESPECT_ROBOTS_TXT` で全体として止められる（ツールごとの上書きは無い）。
 * CAP-M-03（LCC 2026-11-08）。
 *
 * The four tools that open a third-party URL check robots.txt with the `ReftrixBot` token before
 * opening it and return `ROBOTS_TXT_BLOCKED` when disallowed, without launching a browser.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { robotsCheck } = vi.hoisted(() => ({
  robotsCheck: vi.fn(),
}));

vi.mock("@reftrixmcp/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@reftrixmcp/core")>();
  return { ...actual, isUrlAllowedByRobotsTxt: robotsCheck };
});

import { accessibilityAuditHandler } from "../../src/tools/accessibility/audit.tool";
import { performanceEvaluateHandler } from "../../src/tools/performance/evaluate.tool";
import { responsiveCaptureHandler } from "../../src/tools/responsive/capture.tool";
import { motionDetectHandler } from "../../src/tools/motion/detect.tool";
import { designSearchByImageHandler } from "../../src/tools/design/search-by-image.tool";

const URL = "https://example.com/private/page";
const BLOCKED = {
  allowed: false,
  domain: "example.com",
  reason: "disallowed",
  cached: false,
} as const;

type ToolResult = { success: boolean; error?: { code: string; message: string } };

const cases: Array<[string, () => Promise<ToolResult>]> = [
  ["accessibility.audit", () => accessibilityAuditHandler({ url: URL }) as Promise<ToolResult>],
  ["performance.evaluate", () => performanceEvaluateHandler({ url: URL }) as Promise<ToolResult>],
  ["responsive.capture", () => responsiveCaptureHandler({ url: URL }) as Promise<ToolResult>],
  [
    "motion.detect (runtime)",
    () => motionDetectHandler({ url: URL, detection_mode: "runtime" }) as Promise<ToolResult>,
  ],
  [
    "motion.detect (video)",
    () => motionDetectHandler({ url: URL, detection_mode: "video" }) as Promise<ToolResult>,
  ],
];

describe("INV-ROBOTS-URL-TOOLS-001 robots.txt check in URL tools", () => {
  beforeEach(() => {
    robotsCheck.mockReset();
  });

  it.each(cases)(
    "%s returns ROBOTS_TXT_BLOCKED when robots.txt disallows the URL",
    async (_n, run) => {
      robotsCheck.mockResolvedValue(BLOCKED);
      const result = await run();
      expect(robotsCheck).toHaveBeenCalledWith(URL);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("ROBOTS_TXT_BLOCKED");
      expect(result.error?.message).toContain("robots.txt");
    }
  );

  it.each(cases)("%s goes past the robots.txt gate when the URL is allowed", async (_n, run) => {
    robotsCheck.mockResolvedValue({ ...BLOCKED, allowed: true, reason: "allowed" });
    const result = await run();
    expect(robotsCheck).toHaveBeenCalledWith(URL);
    expect(result.error?.code).not.toBe("ROBOTS_TXT_BLOCKED");
  });

  it("motion.detect rejects a private URL with SSRF_BLOCKED before fetching robots.txt (SEC M-1)", async () => {
    robotsCheck.mockResolvedValue(BLOCKED);
    const result = (await motionDetectHandler({
      url: "http://127.0.0.1/admin",
      detection_mode: "runtime",
    })) as ToolResult;
    expect(result.error?.code).toBe("SSRF_BLOCKED");
    expect(robotsCheck).not.toHaveBeenCalled();
  });

  it("design.search_by_image checks robots.txt for an image URL before fetching it", async () => {
    robotsCheck.mockResolvedValue(BLOCKED);
    const result = (await designSearchByImageHandler({ image: "https://example.com/a.png" })) as {
      success: boolean;
      error?: string;
    };
    expect(robotsCheck).toHaveBeenCalledWith("https://example.com/a.png");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^ROBOTS_TXT_BLOCKED: /);
  });
});
