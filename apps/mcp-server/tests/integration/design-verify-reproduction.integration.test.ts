// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * design.verify_reproduction: real Postgres + real Chromium integration.
 *
 * A fixture section is rendered once (offline, JS off) to produce the "stored" reference:
 * component_parts with measured rects / styles, a persisted full-page screenshot under a temp
 * REFTRIX_SCREENSHOT_ROOT, and a vision embedding. DINOv2 is replaced by a deterministic
 * luminance-grid embedder (the real model is ~800 MB); everything else is the production path.
 *
 * Legs: (1) self-render of the stored snippets scores high, (2) a mutated candidate (font-size,
 * colour, removed element) yields those diffs and a lower score, (3) a high-PII part makes pixel
 * and visual `pii_excluded`, (4) screenshot gone -> degrade.
 *
 * HAS_DB-gated; CI without DATABASE_URL FAILS the precondition test (fail-closed). Fixture rows are
 * exact-match cascade-deleted by page id.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { prisma } from "@reftrixmcp/database";
import { clearResolvedRootCache } from "../../src/services/screenshot-persistence.service";
import { renderCandidate } from "../../src/services/design/reproduction-render.service";
import {
  createDefaultDeps,
  type VerifyDinov2,
  type VerifyPrisma,
} from "../../src/services/design/reproduction-verify.service";
import {
  designVerifyReproductionHandler,
  resetDesignVerifyReproductionDepsFactory,
  setDesignVerifyReproductionDepsFactory,
} from "../../src/tools/design/verify-reproduction.tool";

const IS_CI = process.env.CI === "true" || process.env.CI === "1";
const HAS_DB = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0;

/** Capture width of the pixel legs (not the 1920 fallback, so PNG-width detection is exercised). */
const WIDTH = 1440;
/** The width used when no screenshot tells us the capture viewport. */
const FALLBACK_WIDTH = 1920;
const START_Y = 100;

const HTML =
  `<section><h1 class="t">Studio of Quiet Things</h1>` +
  `<p class="s">We design calm identities for small teams.</p>` +
  `<a class="btn" href="#">Contact us</a></section>`;
const CSS =
  `section{padding:40px;background:#fafafa;font-family:sans-serif}` +
  `.t{font-size:40px;color:#111111;margin:0 0 12px}` +
  `.s{font-size:18px;color:#444444;margin:0 0 24px}` +
  `.btn{display:inline-block;padding:12px 24px;background:#111111;color:#ffffff;border-radius:6px;text-decoration:none;font-size:16px}`;

/** Deterministic stand-in for DINOv2: 24x32 luminance grid padded to 768 dims, L2-normalised. */
async function fakeEmbed(png: Buffer): Promise<number[]> {
  const raw = await sharp(png).resize(24, 32, { fit: "fill" }).greyscale().raw().toBuffer();
  const v = Array.from(raw, (b) => b / 255 - 0.5);
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}
const fakeDino: VerifyDinov2 = {
  initialized: true,
  initialize: async () => undefined,
  generateEmbedding: (buf) => fakeEmbed(buf),
  dispose: async () => undefined,
};

const created: string[] = [];
let root = "";
let prevRoot: string | undefined;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reftrix-verify-int-"));
  prevRoot = process.env["REFTRIX_SCREENSHOT_ROOT"];
  process.env["REFTRIX_SCREENSHOT_ROOT"] = root;
  clearResolvedRootCache();
  fs.mkdirSync(path.join(root, "phase5"), { recursive: true });
});

afterEach(async () => {
  resetDesignVerifyReproductionDepsFactory();
  if (HAS_DB && created.length > 0) {
    await prisma.webPage.deleteMany({ where: { id: { in: created.splice(0) } } });
  }
});

afterAll(() => {
  if (prevRoot === undefined) delete process.env["REFTRIX_SCREENSHOT_ROOT"];
  else process.env["REFTRIX_SCREENSHOT_ROOT"] = prevRoot;
  clearResolvedRootCache();
  fs.rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  patternId: string;
  screenshotPath: string;
  height: number;
}

async function createFixture(opts: { highPii?: boolean; width?: number } = {}): Promise<Fixture> {
  const width = opts.width ?? WIDTH;
  const ref = await renderCandidate({ html: HTML, css: CSS, width, height: 400 });
  const height = Math.max(120, ref.contentHeight);
  const webPageId = randomUUID();
  const patternId = randomUUID();
  await prisma.webPage.create({
    data: {
      id: webPageId,
      url: `https://verify-repro-${webPageId}.example.test/`,
      title: "verify_reproduction fixture",
      sourceType: "user_provided",
      usageScope: "inspiration_only",
    },
  });
  created.push(webPageId);

  // full-page screenshot: the section render placed at START_Y on a white page
  const section = await sharp(ref.png).extract({ left: 0, top: 0, width, height }).png().toBuffer();
  const page = await sharp({
    create: { width, height: START_Y + height + 200, channels: 3, background: "#ffffff" },
  })
    .composite([{ input: section, left: 0, top: START_Y }])
    .png()
    .toBuffer();
  const screenshotPath = path.join(root, "phase5", `${webPageId}.png`);
  fs.writeFileSync(screenshotPath, page);
  await prisma.webPage.update({
    where: { id: webPageId },
    data: { screenshotStoragePath: screenshotPath },
  });

  await prisma.sectionPattern.create({
    data: {
      id: patternId,
      webPageId,
      sectionType: "hero",
      positionIndex: 0,
      htmlSnippet: HTML,
      cssSnippet: CSS,
      layoutInfo: { position: { startY: START_Y, height } },
    },
  });
  const snippets: Record<string, string> = {
    heading: `<h1 class="t">Studio of Quiet Things</h1>`,
    link: `<a class="btn" href="#">Contact us</a>`,
  };
  for (const p of ref.parts) {
    const snippet = snippets[p.partType];
    if (!snippet) continue; // keep the reference to heading + link (paragraph has no part type)
    await prisma.componentPart.create({
      data: {
        id: randomUUID(),
        webPageId,
        sectionPatternId: patternId,
        partType: p.partType,
        htmlSnippet: snippet,
        computedStyles: p.styles,
        boundingBox: p.rect,
        attributes: {},
        interactionInfo: {},
        piiRiskLevel: "none",
        extractedAt: new Date(),
      },
    });
  }
  if (opts.highPii) {
    await prisma.componentPart.create({
      data: {
        id: randomUUID(),
        webPageId,
        sectionPatternId: patternId,
        partType: "avatar",
        htmlSnippet: `<img alt="alice@example.com">`,
        computedStyles: {},
        boundingBox: { x: 0, y: 0, width: 10, height: 10 },
        attributes: {},
        interactionInfo: {},
        piiRiskLevel: "high",
        extractedAt: new Date(),
      },
    });
  } else {
    const emb = await fakeEmbed(section);
    await prisma.$executeRawUnsafe(
      `INSERT INTO section_embeddings (id, section_pattern_id, vision_embedding, model_version, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, $2::vector, 'fixture', now())`,
      patternId,
      `[${emb.join(",")}]`
    );
  }
  return { patternId, screenshotPath, height };
}

function register(): void {
  setDesignVerifyReproductionDepsFactory(() =>
    createDefaultDeps(
      prisma as unknown as VerifyPrisma,
      () => fakeDino,
      async (png) => png // the fake embedder resizes itself
    )
  );
}

interface Ok {
  success: true;
  scores: {
    overall: number;
    layoutScore: number | null;
    styleScore: number | null;
    visualSimilarity: number | null;
    pixelMismatchRatio: number | null;
  };
  diffs: Array<{ property: string; partType: string }>;
  missingParts: Array<{ partType: string }>;
  coverage: { pixel: string; visual: string; stylesCompared: number };
  blockedRequests: { count: number };
}

async function verify(patternId: string, html: string, css: string): Promise<Ok> {
  const r = await designVerifyReproductionHandler({
    pattern_id: patternId,
    candidate: { html, css },
    options: { max_diffs: 50 },
  });
  if (!r.success) throw new Error(`verify failed: ${r.error}`);
  return r as unknown as Ok;
}

describe("design.verify_reproduction integration (HAS_DB-gated, fail-closed on CI)", () => {
  it("precondition: CI provides DATABASE_URL", () => {
    if (IS_CI) expect(process.env.DATABASE_URL, "CI MUST provide a real PostgreSQL").toBeTruthy();
    expect(typeof HAS_DB).toBe("boolean");
  });

  it("self-render of the stored snippets scores above the baseline with no diffs", async () => {
    if (!HAS_DB) return;
    const fx = await createFixture();
    register();
    const r = await verify(fx.patternId, HTML, CSS);
    process.stderr.write(
      `[verify-repro measured] self-render ${JSON.stringify(r.scores)} ${JSON.stringify(r.coverage)}\n`
    );
    expect(r.coverage.pixel).toBe("compared");
    expect(r.coverage.visual).toBe("compared");
    expect(r.scores.overall).toBeGreaterThan(0.95);
    expect(r.scores.layoutScore).toBeGreaterThan(0.95);
    expect(r.scores.styleScore).toBeGreaterThan(0.98);
    expect(r.scores.visualSimilarity).toBeGreaterThan(0.99);
    expect(r.scores.pixelMismatchRatio).toBeLessThan(0.01);
    expect(r.diffs).toEqual([]);
    expect(r.coverage.stylesCompared).toBeGreaterThan(0);
  }, 90_000);

  it("a mutated candidate (font-size, colour, removed element) yields those diffs", async () => {
    if (!HAS_DB) return;
    const fx = await createFixture();
    register();
    const baseline = await verify(fx.patternId, HTML, CSS);
    const mutatedCss = CSS.replace(
      ".t{font-size:40px;color:#111111",
      ".t{font-size:24px;color:#cc0000"
    );
    const mutatedHtml = HTML.replace(/<a class="btn"[^>]*>Contact us<\/a>/, "");
    const r = await verify(fx.patternId, mutatedHtml, mutatedCss);
    process.stderr.write(
      `[verify-repro measured] mutated ${JSON.stringify(r.scores)} ${JSON.stringify(r.diffs.slice(0, 6))}\n`
    );
    const headingProps = r.diffs.filter((d) => d.partType === "heading").map((d) => d.property);
    expect(headingProps).toContain("font-size");
    expect(headingProps).toContain("color");
    expect(r.missingParts.map((m) => m.partType)).toContain("link");
    expect(r.scores.overall).toBeLessThan(baseline.scores.overall - 0.1);
    expect(r.scores.pixelMismatchRatio ?? 0).toBeGreaterThan(
      baseline.scores.pixelMismatchRatio ?? 0
    );
  }, 90_000);

  it("external references are blocked and counted, not fetched", async () => {
    if (!HAS_DB) return;
    const fx = await createFixture();
    register();
    const r = await verify(
      fx.patternId,
      HTML + `<img src="https://example.invalid/a.png">`,
      CSS +
        `@font-face{font-family:Z;src:url(https://example.invalid/z.woff2)}.t{font-family:Z,sans-serif}`
    );
    expect(r.blockedRequests.count).toBeGreaterThanOrEqual(2);
  }, 90_000);

  it("a section with a high-PII part skips pixel and visual (pii_excluded) and never returns its text", async () => {
    if (!HAS_DB) return;
    const fx = await createFixture({ highPii: true });
    register();
    const r = await verify(fx.patternId, HTML, CSS);
    expect(r.coverage.pixel).toBe("pii_excluded");
    expect(r.coverage.visual).toBe("pii_excluded");
    expect(r.scores.layoutScore).not.toBeNull();
    expect(JSON.stringify(r)).not.toContain("alice@example.com");
  }, 90_000);

  it("degrades to pixel=unavailable when the screenshot file is gone and recreates nothing", async () => {
    if (!HAS_DB) return;
    // Without a screenshot the render width falls back to 1920, so capture the fixture at 1920.
    const fx = await createFixture({ width: FALLBACK_WIDTH });
    register();
    fs.rmSync(fx.screenshotPath);
    const before = fs.readdirSync(path.join(root, "phase5")).sort();
    const r = await verify(fx.patternId, HTML, CSS);
    expect(r.coverage.pixel).toBe("unavailable");
    expect(r.coverage.visual).toBe("compared");
    expect(r.scores.layoutScore).toBeGreaterThan(0.95);
    expect(fs.readdirSync(path.join(root, "phase5")).sort()).toEqual(before);
    expect(fs.existsSync(fx.screenshotPath)).toBe(false);
  }, 90_000);

  it("returns NOT_FOUND for an unknown pattern", async () => {
    if (!HAS_DB) return;
    register();
    const r = await designVerifyReproductionHandler({
      pattern_id: randomUUID(),
      candidate: { html: HTML },
    });
    expect(r.success).toBe(false);
  });
});
