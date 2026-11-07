// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * VR-M-04 audit M-1: design.verify_reproduction holds the shared DINOv2 semaphore only across
 * get -> initialize -> generateEmbedding -> release. The blank-page render (Chromium) and the DB
 * similarity queries run outside it, so design.search_by_image is never queued behind them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  verifyReproduction,
  type SectionRow,
  type VerifyDeps,
} from "../../../src/services/design/reproduction-verify.service";
import {
  createResidentDinov2,
  dinov2Semaphore,
  type VerifyDinov2,
} from "../../../src/services/design/resident-dinov2";
import {
  designSearchByImageHandler,
  resetDesignSearchDINOv2ResidentFactory,
  resetDesignSearchPrismaClientFactory,
  setDesignSearchDINOv2ResidentFactory,
  setDesignSearchPrismaClientFactory,
} from "../../../src/tools/design/search-by-image.tool";
import { invalidateCache } from "../../../src/services/search-cache.service";
import {
  VALID_BASE64_PNG,
  createMockPrismaClient,
} from "../../tools/design/_helpers/design-search-mocks";

const section: SectionRow = {
  id: "11111111-1111-4111-8111-111111111111",
  layoutInfo: { position: { startY: 100, height: 200 } },
  screenshotPath: "/tmp/x/phase5/a.png",
  visionSkipReason: null,
  hasVisionEmbedding: true,
};
const input = {
  patternId: section.id,
  html: "<h1>x</h1>",
  css: "",
  maxDiffs: 20,
  includeDiffImage: false,
  maskImages: true,
};

async function png(w: number, h: number, v: number): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: v, g: v, b: v } },
  })
    .png()
    .toBuffer();
}

function makeResident(): ReturnType<typeof createResidentDinov2> {
  const dino: VerifyDinov2 = {
    initialized: true,
    initialize: vi.fn(async () => undefined),
    generateEmbedding: vi.fn(async (raw: Buffer) => {
      const m = (raw[0] ?? 0) / 255;
      return [m, 1 - m, 0.5];
    }),
    dispose: vi.fn(async () => undefined),
  };
  return createResidentDinov2(() => dino);
}

afterEach(() => {
  resetDesignSearchDINOv2ResidentFactory();
  resetDesignSearchPrismaClientFactory();
  invalidateCache();
});

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

describe("verify_reproduction DINOv2 lock scope", () => {
  it("does not block search_by_image while verify waits on the blank-page render", async () => {
    const resident = makeResident();
    setDesignSearchDINOv2ResidentFactory(() => resident);
    setDesignSearchPrismaClientFactory(() => createMockPrismaClient([]));
    const toRaw = async (b: Buffer): Promise<Buffer> => sharp(b).removeAlpha().raw().toBuffer();

    let finishBlank: (v: Buffer) => void = () => undefined;
    const blank = new Promise<Buffer>((resolve) => {
      finishBlank = resolve;
    });
    const render = vi.fn(async (i: { html: string; width: number; height: number }) => {
      const pngBuf = i.html === "" ? await blank : await png(i.width, i.height, 120);
      return { png: pngBuf, contentHeight: 200, blockedRequests: 0, parts: [] };
    });
    const deps = {
      loadSection: vi.fn(async () => section),
      loadParts: vi.fn(async () => []),
      getHighPiiSectionIds: vi.fn(async () => new Set<string>()),
      visualSimilarity: vi.fn(async () => 0.9),
      readScreenshot: vi.fn(async () => png(1920, 1000, 120)),
      getDinov2: () => resident.get(),
      releaseDinov2: (d: VerifyDinov2, broken: boolean) => resident.release(d, broken),
      preprocessForDinov2: toRaw,
      preprocessContainForDinov2: toRaw,
      blankEmbeddingCache: new Map<string, number[]>(),
      render,
    } as unknown as VerifyDeps;

    const verify = verifyReproduction(input, deps);
    await until(() => render.mock.calls.some(([i]) => i.html === ""));

    const search = await Promise.race([
      designSearchByImageHandler({ image: VALID_BASE64_PNG }),
      new Promise<"blocked">((r) => setTimeout(() => r("blocked"), 1000)),
    ]);
    expect(search).not.toBe("blocked");

    finishBlank(await png(1920, 200, 255));
    const result = await verify;
    expect(result.coverage.visual).toBe("compared");
    expect(dinov2Semaphore.inFlight()).toBe(0);
    expect(dinov2Semaphore.pending()).toBe(0);
    await resident.shutdown();
  });
});
