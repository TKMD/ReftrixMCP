// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * resolvePartBoundingBoxesWithFallback tests (v0.4.0 PR7e-α)
 *
 * Verifies:
 *   - SSRF re-validation is enforced by default (validateUrl !== false)
 *   - SSRF block short-circuits with ssrfBlocked=true
 *   - Chromium launch is serialised via partBboxLaunchSemaphore (max=1)
 *   - delegation to resolvePartBoundingBoxes maps result shape correctly
 *   - operator triggers audit_logs entry (repair path); absence skips audit
 *
 * @module tests/workers/phases/shared/bbox-resolution.helper
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted: factories must not reference top-level unhoisted variables.
const { mockValidateExternalUrl, mockResolvePartBoundingBoxes, mockAuditLog } = vi.hoisted(() => ({
  mockValidateExternalUrl: vi.fn<[], { valid: boolean; error?: string }>(() => ({ valid: true })),
  mockResolvePartBoundingBoxes: vi.fn(
    async (): Promise<{ resolvedCount: number; skippedCount: number }> => ({
      resolvedCount: 5,
      skippedCount: 1,
    })
  ),
  mockAuditLog: vi.fn(async () => undefined),
}));

vi.mock("../../../../src/utils/url-validator", () => ({
  validateExternalUrl: mockValidateExternalUrl,
}));

vi.mock("../../../../src/services/part/part-bbox-playwright.service", () => ({
  resolvePartBoundingBoxes: mockResolvePartBoundingBoxes,
}));

vi.mock("../../../../src/services/audit-log.service", async (importOriginal) => {
  // Wave 5 LCC canonical pattern: re-export `AUDIT_LOG_CONSTANTS` SSOT from
  // the original module so callers that compute `webPageId.slice(0,
  // AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH)` keep working. Only
  // `getAuditLogService` is replaced with a mock to capture audit writes.
  // Anchor: FIND-IMPL-LCC-PATCH-W5-02 (Wave 5 LCC canonical anchor 019df7ab-2f5a).
  const actual =
    await importOriginal<typeof import("../../../../src/services/audit-log.service")>();
  return {
    ...actual,
    getAuditLogService: () => ({ log: mockAuditLog }),
  };
});

import {
  resolvePartBoundingBoxesWithFallback,
  type BboxResolutionParams,
} from "../../../../src/workers/phases/shared/bbox-resolution.helper";
import { partBboxLaunchSemaphore } from "../../../../src/utils/launch-semaphore";

function makeParams(overrides: Partial<BboxResolutionParams> = {}): BboxResolutionParams {
  return {
    webPageId: "019bc123-4567-7890-abcd-ef1234567890",
    url: "https://example.com",
    // biome-ignore lint: test stub
    prisma: {} as never,
    sharedBrowser: null,
    ...overrides,
  };
}

describe("resolvePartBoundingBoxesWithFallback (v0.4.0 PR7e-α)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateExternalUrl.mockReturnValue({ valid: true });
    mockResolvePartBoundingBoxes.mockResolvedValue({ resolvedCount: 5, skippedCount: 1 });
  });

  describe("SSRF re-validation (SEC HIGH-1)", () => {
    it("blocks with ssrfBlocked=true when validateExternalUrl rejects", async () => {
      mockValidateExternalUrl.mockReturnValueOnce({ valid: false, error: "private IP" });
      const result = await resolvePartBoundingBoxesWithFallback(makeParams());
      expect(result).toEqual({ ssrfBlocked: true, resolvedCount: 0, skippedCount: 0 });
      expect(mockResolvePartBoundingBoxes).not.toHaveBeenCalled();
    });

    it("does NOT skip SSRF check by default", async () => {
      await resolvePartBoundingBoxesWithFallback(makeParams());
      expect(mockValidateExternalUrl).toHaveBeenCalledTimes(1);
    });

    it("skips SSRF check only when validateUrl === false", async () => {
      await resolvePartBoundingBoxesWithFallback(makeParams({ validateUrl: false }));
      expect(mockValidateExternalUrl).not.toHaveBeenCalled();
      expect(mockResolvePartBoundingBoxes).toHaveBeenCalledTimes(1);
    });
  });

  describe("Delegation (PR7e-α wiring)", () => {
    it("delegates to resolvePartBoundingBoxes and maps result", async () => {
      mockResolvePartBoundingBoxes.mockResolvedValueOnce({ resolvedCount: 7, skippedCount: 3 });
      const result = await resolvePartBoundingBoxesWithFallback(makeParams());
      expect(result).toEqual({ ssrfBlocked: false, resolvedCount: 7, skippedCount: 3 });
    });

    it("forwards viewportWidth / viewportHeight when provided", async () => {
      await resolvePartBoundingBoxesWithFallback(
        makeParams({ viewportWidth: 1920, viewportHeight: 1080 })
      );
      expect(mockResolvePartBoundingBoxes).toHaveBeenCalledWith(
        expect.objectContaining({ viewportWidth: 1920, viewportHeight: 1080 })
      );
    });
  });

  describe("LaunchSemaphore (SEC HIGH-3)", () => {
    it("releases semaphore permit even on delegation throw", async () => {
      mockResolvePartBoundingBoxes.mockRejectedValueOnce(new Error("chromium failure"));
      const before = partBboxLaunchSemaphore.inFlight();
      await expect(resolvePartBoundingBoxesWithFallback(makeParams())).rejects.toThrow(
        /chromium failure/
      );
      expect(partBboxLaunchSemaphore.inFlight()).toBe(before);
    });
  });

  describe("audit_logs (LCC MEDIUM-2 / repair path)", () => {
    it("emits audit_logs entry when operator is provided", async () => {
      await resolvePartBoundingBoxesWithFallback(makeParams({ operator: "pipeline-engineer" }));
      expect(mockAuditLog).toHaveBeenCalledTimes(1);
      const entry = mockAuditLog.mock.calls[0]?.[0] as {
        action: string;
        actor: string;
        targetType: string;
      };
      expect(entry?.action).toBe("part_bbox_resolved_via_repair");
      expect(entry?.actor).toBe("repair-script:pipeline-engineer");
      expect(entry?.targetType).toBe("web_page");
    });

    it("does NOT emit audit_logs when operator is absent (Backfill / Phase 5 paths)", async () => {
      await resolvePartBoundingBoxesWithFallback(makeParams());
      expect(mockAuditLog).not.toHaveBeenCalled();
    });

    it("audit_logs failure is non-fatal (still returns result)", async () => {
      mockAuditLog.mockRejectedValueOnce(new Error("audit DB down"));
      const result = await resolvePartBoundingBoxesWithFallback(
        makeParams({ operator: "pipeline-engineer" })
      );
      expect(result.resolvedCount).toBe(5);
    });
  });
});
