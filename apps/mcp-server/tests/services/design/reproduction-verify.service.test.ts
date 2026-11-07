// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  VerifyNotFoundError,
  readSectionRegion,
  verifyReproduction,
  type PartRow,
  type SectionRow,
  type VerifyDeps,
} from "../../../src/services/design/reproduction-verify.service";
import type { RenderResult } from "../../../src/services/design/reproduction-render.service";

async function png(w: number, h: number, rgb: [number, number, number]): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })
    .png()
    .toBuffer();
}

const GREY: [number, number, number] = [120, 120, 120];
const WHITE: [number, number, number] = [255, 255, 255];

const baseSection: SectionRow = {
  id: "11111111-1111-4111-8111-111111111111",
  layoutInfo: { position: { startY: 100, height: 200 } },
  screenshotPath: "/tmp/x/phase5/a.png",
  visionSkipReason: null,
  hasVisionEmbedding: true,
};
const headingPart: PartRow = {
  partType: "heading",
  htmlSnippet: "<h1>Hello World</h1>",
  boundingBox: { x: 0, y: 0, width: 300, height: 40 },
  computedStyles: { "font-size": "32px" },
  piiRiskLevel: "none",
};

function makeDeps(over: Partial<VerifyDeps> = {}, rendered?: Partial<RenderResult>) {
  const dino = {
    initialized: false,
    initialize: vi.fn(async () => undefined),
    // Content-dependent fake: the first raw byte decides the vector, so a grey image and a white one
    // embed differently while two greys embed identically.
    generateEmbedding: vi.fn(async (raw: Buffer) => {
      const m = (raw[0] ?? 0) / 255;
      return [m, 1 - m, 0.5];
    }),
    dispose: vi.fn(async () => undefined),
  };
  const toRawRgb = async (b: Buffer): Promise<Buffer> => sharp(b).removeAlpha().raw().toBuffer();
  const deps: VerifyDeps = {
    loadSection: vi.fn(async () => baseSection),
    loadParts: vi.fn(async () => [headingPart]),
    getHighPiiSectionIds: vi.fn(async () => new Set<string>()),
    visualSimilarity: vi.fn(async () => 0.9),
    readScreenshot: vi.fn(async () => png(1920, 1000, GREY)),
    getDinov2: () => dino,
    preprocessForDinov2: vi.fn(toRawRgb),
    preprocessContainForDinov2: vi.fn(toRawRgb),
    // The blank baseline render (empty html) is white; the candidate render is the reference grey.
    render: vi.fn(async (i) => ({
      png: await png(i.width, i.height, i.html === "" ? WHITE : GREY),
      contentHeight: 200,
      blockedRequests: 2,
      parts: [
        {
          partType: "heading",
          text: "Hello World",
          rect: { x: 0, y: 0, width: 300, height: 40 },
          styles: { "font-size": "32px" },
        },
      ],
      ...rendered,
    })),
    ...over,
  };
  return { deps, dino };
}
const input = {
  patternId: baseSection.id,
  html: "<h1>x</h1>",
  css: "",
  maxDiffs: 20,
  includeDiffImage: false,
  maskImages: true,
};

describe("verifyReproduction ignoreText (VR-M-03)", () => {
  const otherText = {
    parts: [
      {
        partType: "heading",
        text: "Something else entirely",
        rect: { x: 0, y: 0, width: 300, height: 40 },
        styles: { "font-size": "32px" },
      },
    ],
  };

  it("default output does not mention ignored text", async () => {
    const { deps } = makeDeps();
    const r = await verifyReproduction(input, deps);
    expect(r.textIgnored).toBeUndefined();
  });

  it("states that text was ignored and scores identically for different text", async () => {
    const a = await verifyReproduction({ ...input, ignoreText: true }, makeDeps().deps);
    const b = await verifyReproduction(
      { ...input, ignoreText: true },
      makeDeps({}, otherText).deps
    );
    expect(a.textIgnored).toBe(true);
    expect(a.textIgnoredNote).toMatch(/pixel/i);
    expect(b.scores.layoutScore).toBe(a.scores.layoutScore);
    expect(b.scores.styleScore).toBe(a.scores.styleScore);
    expect(b.matchedParts).toBe(a.matchedParts);
    expect(b.missingParts).toEqual(a.missingParts);
  });
});

describe("verifyReproduction", () => {
  it("compares all four components for a faithful reproduction", async () => {
    const { deps, dino } = makeDeps();
    const r = await verifyReproduction(input, deps);
    expect(r.coverage.pixel).toBe("compared");
    expect(r.coverage.visual).toBe("compared");
    expect(r.scores.pixelMismatchRatio).toBe(0);
    expect(r.scores.visualSimilarity).toBeCloseTo(1);
    expect(r.coverage.visualBasis).toBe("screenshot");
    expect(r.scores.layoutScore).toBeGreaterThan(0.95);
    expect(r.scores.overall).toBeGreaterThan(0.9);
    expect(r.blockedRequests).toEqual({ count: 2 });
    expect(r.heightDelta).toBe(0);
    expect(dino.dispose).toHaveBeenCalledOnce();
  });

  it("renders at the PNG width and the section height", async () => {
    const { deps } = makeDeps();
    await verifyReproduction(input, deps);
    expect(deps.render).toHaveBeenCalledWith(expect.objectContaining({ width: 1920, height: 200 }));
  });

  it("degrades (no error) when the screenshot is gone: pixel unavailable, visual + layout still run", async () => {
    const { deps } = makeDeps({ readScreenshot: vi.fn(async () => null) });
    const r = await verifyReproduction(input, deps);
    expect(r.coverage.pixel).toBe("unavailable");
    expect(r.coverage.pixelReason).toBe("screenshot_missing");
    expect(r.scores.pixelMismatchRatio).toBeNull();
    expect(r.coverage.visual).toBe("compared");
    expect(r.scores.layoutScore).not.toBeNull();
  });

  it("degrades when screenshot_storage_path is null and never reads", async () => {
    const { deps } = makeDeps({
      loadSection: vi.fn(async () => ({ ...baseSection, screenshotPath: null })),
    });
    const r = await verifyReproduction(input, deps);
    expect(r.coverage.pixelReason).toBe("screenshot_missing");
    expect(deps.readScreenshot).not.toHaveBeenCalled();
  });

  it("skips pixel and visual for a section holding a high-PII part (SSOT set)", async () => {
    const { deps, dino } = makeDeps({
      getHighPiiSectionIds: vi.fn(async () => new Set([baseSection.id])),
    });
    const r = await verifyReproduction(input, deps);
    expect(r.coverage.pixel).toBe("pii_excluded");
    expect(r.coverage.visual).toBe("pii_excluded");
    expect(deps.readScreenshot).not.toHaveBeenCalled();
    expect(dino.generateEmbedding).not.toHaveBeenCalled();
    expect(r.scores.layoutScore).not.toBeNull();
  });

  it("skips pixel and visual for section_visual_pii_excluded", async () => {
    const { deps } = makeDeps({
      loadSection: vi.fn(async () => ({
        ...baseSection,
        visionSkipReason: "section_visual_pii_excluded",
        hasVisionEmbedding: false,
      })),
    });
    const r = await verifyReproduction(input, deps);
    expect(r.coverage.pixel).toBe("pii_excluded");
    expect(r.coverage.visual).toBe("pii_excluded");
  });

  it("never returns text of high-PII parts", async () => {
    const { deps } = makeDeps({
      loadParts: vi.fn(async () => [
        { ...headingPart, htmlSnippet: null, piiRiskLevel: "high" },
        headingPart,
      ]),
    });
    const r = await verifyReproduction(input, deps);
    expect(JSON.stringify(r)).not.toContain("alice");
  });

  it("marks the visual comparison unavailable when neither a screenshot nor an embedding exists", async () => {
    const { deps } = makeDeps({
      loadSection: vi.fn(async () => ({ ...baseSection, hasVisionEmbedding: false })),
      readScreenshot: vi.fn(async () => null),
    });
    const r = await verifyReproduction(input, deps);
    expect(r.coverage.visual).toBe("unavailable");
    expect(r.coverage.visualReason).toBe("reference_embedding_missing");
  });

  it("treats a DINOv2 failure as unavailable, not as an error, and still disposes", async () => {
    const { deps, dino } = makeDeps();
    dino.generateEmbedding.mockRejectedValueOnce(new Error("onnx boom"));
    const r = await verifyReproduction(input, deps);
    expect(r.coverage.visual).toBe("unavailable");
    expect(dino.dispose).toHaveBeenCalledOnce();
  });

  it("rejects an implausible reference width (scaled capture) for the pixel leg only", async () => {
    const { deps } = makeDeps({
      readScreenshot: vi.fn(async () => png(5000, 900, [255, 255, 255])),
    });
    const r = await verifyReproduction(input, deps);
    expect(r.coverage.pixelReason).toBe("reference_scale_unsupported");
    expect(r.coverage.visual).toBe("compared");
  });

  it("detects a pixel mismatch and returns a bounded diff image on request", async () => {
    const { deps } = makeDeps();
    deps.render = vi.fn(async (i) => ({
      png: await png(i.width, i.height, [0, 0, 0]),
      contentHeight: 150,
      blockedRequests: 0,
      parts: [],
    }));
    const r = await verifyReproduction({ ...input, includeDiffImage: true }, deps);
    expect(r.scores.pixelMismatchRatio).toBeGreaterThan(0.9);
    expect(r.diffImage?.width).toBeLessThanOrEqual(256);
    expect(r.heightDelta).toBe(-50);
    expect(r.missingParts).toHaveLength(1);
  });

  it("throws NotFound for an unknown pattern", async () => {
    const { deps } = makeDeps({ loadSection: vi.fn(async () => null) });
    await expect(verifyReproduction(input, deps)).rejects.toBeInstanceOf(VerifyNotFoundError);
  });
});

describe("readSectionRegion", () => {
  it("reads startY/height and rejects bad values", () => {
    expect(readSectionRegion({ position: { startY: 5, height: 10 } })).toEqual({
      startY: 5,
      height: 10,
    });
    expect(readSectionRegion({})).toBeNull();
    expect(readSectionRegion({ position: { startY: -1, height: 10 } })).toBeNull();
    expect(readSectionRegion({ position: { startY: 0, height: 0 } })).toBeNull();
  });

  it("treats a stored region that runs past the image bottom as out of range (no partial compare)", async () => {
    const { deps } = makeDeps({
      loadSection: vi.fn(async () => ({
        ...baseSection,
        layoutInfo: { position: { startY: 900, height: 200 } },
      })),
    });
    const r = await verifyReproduction(input, deps);
    expect(r.coverage.pixel).toBe("unavailable");
    expect(r.coverage.pixelReason).toBe("section_region_out_of_range");
  });

  it("masks 2,000 overlapping full-size image parts in bounded time (CWE-770)", async () => {
    const { deps } = makeDeps(
      {},
      {
        parts: Array.from({ length: 2000 }, () => ({
          partType: "image",
          text: "",
          rect: { x: 0, y: 0, width: 1920, height: 200 },
          styles: {},
        })),
      }
    );
    const t0 = performance.now();
    const r = await verifyReproduction(input, deps);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(r.coverage.pixel).toBe("compared");
  });

  it("runs at most one DINOv2 comparison at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    const dino = {
      initialized: true,
      initialize: vi.fn(async () => undefined),
      generateEmbedding: vi.fn(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
        return new Array<number>(768).fill(0.1);
      }),
      dispose: vi.fn(async () => undefined),
    };
    const { deps } = makeDeps({ getDinov2: () => dino });
    await Promise.all([1, 2, 3].map(() => verifyReproduction(input, deps)));
    expect(peak).toBe(1);
  });

  it("returns the beyond-reference-cap count", async () => {
    const { deps } = makeDeps();
    const r = await verifyReproduction(input, deps);
    expect(r.beyondReferenceCap).toBe(0);
  });
});

describe("verifyReproduction visual score (blank-baseline rescale)", () => {
  it("screenshot basis: the reference itself scores 1 and a blank page scores 0", async () => {
    const { deps } = makeDeps();
    const same = await verifyReproduction(input, deps);
    expect(same.coverage.visualBasis).toBe("screenshot");
    expect(same.scores.visualSimilarity).toBeCloseTo(1, 5);
    expect(same.coverage.visualBlankBaseline).toBeGreaterThan(0);
    expect(same.coverage.visualBlankBaseline).toBeLessThan(1);

    const blank = makeDeps();
    blank.deps.render = vi.fn(async (i) => ({
      png: await png(i.width, i.height, WHITE),
      contentHeight: 200,
      blockedRequests: 0,
      parts: [],
    }));
    const r = await verifyReproduction(input, blank.deps);
    expect(r.scores.visualSimilarity).toBeCloseTo(0, 5);
  });

  it("screenshot basis does not need the stored embedding", async () => {
    const { deps } = makeDeps({
      loadSection: vi.fn(async () => ({ ...baseSection, hasVisionEmbedding: false })),
    });
    const r = await verifyReproduction(input, deps);
    expect(r.coverage.visual).toBe("compared");
    expect(r.coverage.visualBasis).toBe("screenshot");
    expect(deps.visualSimilarity).not.toHaveBeenCalled();
  });

  it("stored-embedding basis (no screenshot): rescales the stored cosine against the blank render", async () => {
    const { deps } = makeDeps({
      readScreenshot: vi.fn(async () => null),
      // the blank (white) render embeds with a first component of 1
      visualSimilarity: vi.fn(async (_id: string, e: number[]) => (e[0] === 1 ? 0.6 : 0.8)),
    });
    const r = await verifyReproduction(input, deps);
    expect(r.coverage.visualBasis).toBe("stored_embedding");
    expect(r.coverage.visualBlankBaseline).toBeCloseTo(0.6);
    expect(r.scores.visualSimilarity).toBeCloseTo(0.5);
    expect(deps.preprocessContainForDinov2).not.toHaveBeenCalled();
  });

  it("clamps a candidate that looks less like the reference than a blank page to 0", async () => {
    const { deps } = makeDeps({
      readScreenshot: vi.fn(async () => null),
      visualSimilarity: vi.fn(async (_id: string, e: number[]) => (e[0] === 1 ? 0.7 : 0.4)),
    });
    const r = await verifyReproduction(input, deps);
    expect(r.scores.visualSimilarity).toBe(0);
  });

  it("reports the raw cosine when the reference itself looks blank (no division by ~0)", async () => {
    const { deps } = makeDeps({
      readScreenshot: vi.fn(async () => null),
      visualSimilarity: vi.fn(async (_id: string, e: number[]) => (e[0] === 1 ? 0.995 : 0.97)),
    });
    const r = await verifyReproduction(input, deps);
    expect(r.scores.visualSimilarity).toBeCloseTo(0.97);
    expect(r.coverage.visualRescaled).toBe(false);
  });

  it("marks a normal comparison as rescaled", async () => {
    const { deps } = makeDeps();
    const r = await verifyReproduction(input, deps);
    expect(r.coverage.visualRescaled).toBe(true);
  });

  it("shares the blank baseline across deps objects rebuilt per call (production factory)", async () => {
    const shared = new Map<string, number[]>();
    const a = makeDeps({ blankEmbeddingCache: shared });
    const b = makeDeps({ blankEmbeddingCache: shared });
    await verifyReproduction(input, a.deps);
    await verifyReproduction(input, b.deps);
    const blanks = [a.deps, b.deps]
      .flatMap((d) => vi.mocked(d.render).mock.calls)
      .filter(([i]) => i.html === "" && i.css === "").length;
    expect(blanks).toBe(1);
  });

  it("a failed baseline render never touches the resident DINOv2 and reports the reason", async () => {
    const release = vi.fn(async () => undefined);
    const { deps } = makeDeps({ releaseDinov2: release, blankEmbeddingCache: new Map() });
    const real = deps.render;
    deps.render = vi.fn(async (i) => {
      if (i.html === "") throw new Error("browser launch failed");
      return real(i);
    });
    const r = await verifyReproduction(input, deps);
    expect(r.coverage.visual).toBe("unavailable");
    expect(r.coverage.visualReason).toBe("visual_baseline_failed");
    // The blank render now happens before the model is taken, so the model is neither used nor dropped.
    expect(release).not.toHaveBeenCalled();
  });

  it("falls back to the stored embedding when the contain preprocessing is not wired", async () => {
    const { deps } = makeDeps({
      visualSimilarity: vi.fn(async (_id: string, e: number[]) => (e[0] === 1 ? 0.6 : 0.8)),
    });
    delete (deps as Partial<VerifyDeps>).preprocessContainForDinov2;
    const r = await verifyReproduction(input, deps);
    expect(r.coverage.visualBasis).toBe("stored_embedding");
  });

  it("renders the blank baseline once per size and reuses it", async () => {
    const { deps } = makeDeps();
    await verifyReproduction(input, deps);
    await verifyReproduction(input, deps);
    const blankRenders = vi
      .mocked(deps.render)
      .mock.calls.filter(([i]) => i.html === "" && i.css === "").length;
    expect(blankRenders).toBe(1);
  });
});

describe("verifyReproduction layout coverage", () => {
  it("reports how many reference parts carry a position", async () => {
    const { deps } = makeDeps({
      loadParts: vi.fn(async () => [headingPart, { ...headingPart, boundingBox: null }]),
    });
    const r = await verifyReproduction(input, deps);
    expect(r.coverage.referencePartsWithPosition).toBe(1);
    expect(r.coverage.referencePartsTotal).toBe(2);
  });
});
