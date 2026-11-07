// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-VERIFY-REPRO-NO-SCREENSHOT-WRITE-001 (H, gdpr-delete)
 *
 * `design.verify_reproduction` is a READER of the persisted screenshot (ADR-0041 Amendment: reader
 * added, retention contract unchanged). Once the screenshot file and/or its path are gone
 * (data.delete, or the screenshot expiry), the tool must degrade (`coverage.pixel = "unavailable"`,
 * success) and must NOT recreate any screenshot / crop / cache file. Retention stays "until
 * data.delete" plus whatever expiry the retention work defines; this tool never extends it.
 *
 * Legs:
 *  (a) behaviour: with a real PNG under a temp REFTRIX_SCREENSHOT_ROOT the pixel leg runs; after the
 *      file is deleted (path still set) and with a null path, the result degrades and the root's
 *      file tree is byte-identical before / after (nothing created, not even a directory).
 *  (b) source scan: the tool + its services contain no filesystem write API and never pass `path`
 *      to a screenshot call (Playwright would write the file).
 *
 * P0 standing regression. `.skip()` / `.todo()` are prohibited.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { assertInvName } from "../_setup/inv-assert";
import { clearResolvedRootCache } from "../../../../src/services/screenshot-persistence.service";
import {
  createDefaultDeps,
  verifyReproduction,
  type VerifyPrisma,
} from "../../../../src/services/design/reproduction-verify.service";

const SRC = path.resolve(__dirname, "../../../../src");
const SCAN_FILES = [
  "services/design/reproduction-verify.service.ts",
  "services/design/reproduction-render.service.ts",
  "services/design/reproduction-scoring.ts",
  "tools/design/verify-reproduction.tool.ts",
].map((f) => path.join(SRC, f));

const SECTION_ID = "22222222-2222-4222-8222-222222222222";
const PAGE_ID = "33333333-3333-4333-8333-333333333333";

let root = "";
let shotPath = "";
let prevRoot: string | undefined;

function tree(dir: string): string[] {
  if (!fs.existsSync(dir)) return ["<absent>"];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      out.push(path.relative(dir, full) + (e.isDirectory() ? "/" : ""));
      if (e.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

function fakePrisma(storagePath: string | null): VerifyPrisma {
  return {
    $queryRawUnsafe: (async (sql: string) => {
      if (sql.includes("FROM section_patterns")) {
        return [
          {
            id: SECTION_ID,
            layout_info: { position: { startY: 10, height: 100 } },
            screenshot_storage_path: storagePath,
            vision_skip_reason: null,
            has_vision: false,
          },
        ];
      }
      return [];
    }) as VerifyPrisma["$queryRawUnsafe"],
  };
}

async function run(storagePath: string | null) {
  const deps = createDefaultDeps(
    fakePrisma(storagePath),
    () => null,
    async (b) => b
  );
  deps.getHighPiiSectionIds = vi.fn(async () => new Set<string>());
  deps.render = vi.fn(async (i) => ({
    png: await sharp({
      create: { width: i.width, height: i.height, channels: 3, background: "#ffffff" },
    })
      .png()
      .toBuffer(),
    contentHeight: i.height,
    blockedRequests: 0,
    parts: [],
  }));
  return verifyReproduction(
    {
      patternId: SECTION_ID,
      html: "<p>x</p>",
      css: "",
      maxDiffs: 5,
      includeDiffImage: false,
      maskImages: true,
    },
    deps
  );
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reftrix-verify-repro-"));
  prevRoot = process.env["REFTRIX_SCREENSHOT_ROOT"];
  process.env["REFTRIX_SCREENSHOT_ROOT"] = root;
  clearResolvedRootCache();
  fs.mkdirSync(path.join(root, "phase5"), { recursive: true });
  shotPath = path.join(root, "phase5", `${PAGE_ID}.png`);
  fs.writeFileSync(
    shotPath,
    await sharp({ create: { width: 800, height: 400, channels: 3, background: "#ffffff" } })
      .png()
      .toBuffer()
  );
});

afterAll(() => {
  if (prevRoot === undefined) delete process.env["REFTRIX_SCREENSHOT_ROOT"];
  else process.env["REFTRIX_SCREENSHOT_ROOT"] = prevRoot;
  clearResolvedRootCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("INV-VERIFY-REPRO-NO-SCREENSHOT-WRITE-001", () => {
  it("INV-VERIFY-REPRO-NO-SCREENSHOT-WRITE-001 reads the screenshot when it exists (pixel compared)", async () => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-VERIFY-REPRO-NO-SCREENSHOT-WRITE-001"
    );
    const before = tree(root);
    const r = await run(shotPath);
    expect(r.coverage.pixel).toBe("compared");
    expect(tree(root)).toEqual(before);
  });

  it("INV-VERIFY-REPRO-NO-SCREENSHOT-WRITE-001 degrades and creates nothing after the file is deleted (path still set)", async () => {
    fs.rmSync(shotPath);
    const before = tree(root);
    const r = await run(shotPath);
    expect(r.coverage.pixel).toBe("unavailable");
    expect(r.coverage.pixelReason).toBe("screenshot_missing");
    expect(r.scores.layoutScore).toBeNull(); // no reference parts in this fixture, still a success
    expect(tree(root)).toEqual(before);
    expect(fs.existsSync(shotPath)).toBe(false);
  });

  it("INV-VERIFY-REPRO-NO-SCREENSHOT-WRITE-001 degrades and creates nothing when the path is NULL", async () => {
    const before = tree(root);
    const r = await run(null);
    expect(r.coverage.pixel).toBe("unavailable");
    expect(tree(root)).toEqual(before);
  });

  it("INV-VERIFY-REPRO-NO-SCREENSHOT-WRITE-001 refuses a path outside the screenshot root (no read, degrade)", async () => {
    const outside = path.join(os.tmpdir(), "reftrix-outside.png");
    fs.writeFileSync(outside, "x");
    try {
      const r = await run(outside);
      expect(r.coverage.pixel).toBe("unavailable");
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("INV-VERIFY-REPRO-NO-SCREENSHOT-WRITE-001 source scan: no fs write API, no screenshot `path:` option", () => {
    const writeApi =
      /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|mkdtemp|rename|renameSync|copyFile|copyFileSync|unlink|unlinkSync|rmSync|rmdir|truncate)\s*\(/;
    for (const file of SCAN_FILES) {
      const code = fs
        .readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code, path.basename(file)).not.toMatch(writeApi);
      expect(code, path.basename(file)).not.toMatch(/screenshot\(\s*\{[^}]*\bpath\s*:/);
      expect(code, path.basename(file)).not.toMatch(/\b(cropStoragePath|crop_storage_path)\b/);
      expect(code, path.basename(file)).not.toMatch(/screenshotStoragePath\s*:/);
    }
  });

  it("INV-VERIFY-REPRO-NO-SCREENSHOT-WRITE-001 source scan: no DB mutation (raw SQL or Prisma write API)", () => {
    const sqlWrite = /\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE)\b/;
    const prismaWrite =
      /\.(update|updateMany|upsert|create|createMany|delete|deleteMany|\$executeRaw|\$executeRawUnsafe)\s*\(/;
    for (const file of SCAN_FILES) {
      const code = fs
        .readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code, path.basename(file)).not.toMatch(sqlWrite);
      expect(code, path.basename(file)).not.toMatch(prismaWrite);
    }
  });
});
