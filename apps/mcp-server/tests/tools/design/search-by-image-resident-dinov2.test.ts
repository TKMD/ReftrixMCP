// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * VR-M-04: design.search_by_image shares ONE resident DINOv2 instance (the same one
 * design.verify_reproduction uses) instead of creating a new model per call.
 * Before: each call created a DINOv2Service, initialized it and never released it, so the MCP
 * process RSS kept growing with every call (see tracked-issues/tool-surface.md VR-M-04).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  designSearchByImageHandler,
  resetDesignSearchDINOv2ServiceFactory,
  resetDesignSearchDINOv2ResidentFactory,
  resetDesignSearchPrismaClientFactory,
  setDesignSearchDINOv2ResidentFactory,
  setDesignSearchPrismaClientFactory,
} from "../../../src/tools/design/search-by-image.tool";
import {
  createResidentDinov2,
  dinov2Semaphore,
  type VerifyDinov2,
} from "../../../src/services/design/resident-dinov2";
import * as verifyService from "../../../src/services/design/reproduction-verify.service";
import { invalidateCache } from "../../../src/services/search-cache.service";
import {
  MOCK_VISION_EMBEDDING,
  VALID_BASE64_PNG,
  createMockPrismaClient,
} from "./_helpers/design-search-mocks";

function fakeDino(
  overrides: Partial<VerifyDinov2> = {}
): VerifyDinov2 & { dispose: ReturnType<typeof vi.fn> } {
  return {
    initialized: true,
    initialize: vi.fn(async () => undefined),
    generateEmbedding: vi.fn(async () => MOCK_VISION_EMBEDDING),
    dispose: vi.fn(async () => undefined),
    ...overrides,
  } as VerifyDinov2 & { dispose: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  invalidateCache();
  setDesignSearchPrismaClientFactory(() => createMockPrismaClient([]));
});

afterEach(() => {
  expect(dinov2Semaphore.inFlight()).toBe(0);
  expect(dinov2Semaphore.pending()).toBe(0);
  resetDesignSearchDINOv2ServiceFactory();
  resetDesignSearchDINOv2ResidentFactory();
  resetDesignSearchPrismaClientFactory();
});

describe("design.search_by_image resident DINOv2 (VR-M-04)", () => {
  it("reuses one instance across calls and never disposes it between calls", async () => {
    const made: ReturnType<typeof fakeDino>[] = [];
    const resident = createResidentDinov2(() => {
      const d = fakeDino();
      made.push(d);
      return d;
    });
    setDesignSearchDINOv2ResidentFactory(() => resident);

    for (let i = 0; i < 4; i++) {
      // A different image each time so the result cache does not short-circuit the call.
      const result = await designSearchByImageHandler({
        image: `${VALID_BASE64_PNG}${"A".repeat(i * 4)}`,
        limit: 1 + i,
      });
      expect(result.success).toBe(true);
    }

    expect(made).toHaveLength(1);
    expect(made[0]?.generateEmbedding).toHaveBeenCalledTimes(4);
    expect(made[0]?.dispose).not.toHaveBeenCalled();
    await resident.shutdown();
  });

  it("drops the instance when embedding fails, then loads a fresh one on the next call", async () => {
    const made: ReturnType<typeof fakeDino>[] = [];
    const resident = createResidentDinov2(() => {
      const d = fakeDino(
        made.length === 0
          ? { generateEmbedding: vi.fn(async () => Promise.reject(new Error("boom"))) }
          : {}
      );
      made.push(d);
      return d;
    });
    setDesignSearchDINOv2ResidentFactory(() => resident);

    const failed = await designSearchByImageHandler({ image: VALID_BASE64_PNG });
    expect(failed.success).toBe(false);
    expect(made[0]?.dispose).toHaveBeenCalledOnce();

    const ok = await designSearchByImageHandler({ image: VALID_BASE64_PNG });
    expect(ok.success).toBe(true);
    expect(made).toHaveLength(2);
    await resident.shutdown();
  });

  it("releases the shared semaphore after a call", async () => {
    const resident = createResidentDinov2(() => fakeDino());
    setDesignSearchDINOv2ResidentFactory(() => resident);
    await designSearchByImageHandler({ image: VALID_BASE64_PNG });
    expect(dinov2Semaphore.inFlight()).toBe(0);
    expect(dinov2Semaphore.pending()).toBe(0);
    await resident.shutdown();
  });

  it("is the same module and semaphore design.verify_reproduction uses", () => {
    expect(verifyService.createResidentDinov2).toBe(createResidentDinov2);
  });
});
