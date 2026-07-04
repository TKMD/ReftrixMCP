// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-CROP-BACKFILL-CLAMP-HONEST-SKIP + INV-CROP-BACKFILL-ROBOTS-001
 * (M, W6 Issue A PR-4a, F-M-02 + F-M-05).
 *
 * Context / 背景:
 *   PR-4a adds a one-shot crop-backfill operator script (`scripts/backfill-crops.ts`)
 *   that re-cuts viewable PNG crops from the persisted screenshot for
 *   already-embedded rows (no embedding re-run). Two binding contracts:
 *
 *   F-M-02 (clamp honest-skip): the crop-cut SSOT `cutCropFromScreenshot`
 *     (`crop-persistence.helper.ts`) returns a real PNG Buffer for an in-range
 *     bbox, and `null` (honest-skip — NO garbage 1px-sliver crop, the `019ecfe4`
 *     failure mode) for a clamp-zero / fully-off-screen / NaN bbox. The script
 *     must NOT persist a crop for a null cut.
 *
 *   F-M-05 (robots mandatory pre-flight): backfill is an independent NEW live
 *     visit (NOT a Phase 0 same-host re-nav), so `isUrlAllowedByRobotsTxt` is a
 *     MANDATORY pre-flight gate alongside `validateExternalUrl`. A genuine
 *     Disallow → honest skip + `audit_logs` (skipReason=robots_disallowed). The
 *     gate is AST source-pinned so a future refactor that drops it is CI-RED.
 *
 * Invariant / 不変条件:
 *   - CLAMP runtime: cutCropFromScreenshot returns a Buffer for in-range, null for
 *     clamp-zero / off-screen / NaN (real Sharp cut exercised, not just pinned).
 *   - CLAMP source-pin: backfill-crops.ts persists ONLY when the cut is non-null
 *     (no garbage crop when null).
 *   - ROBOTS source-pin: backfill-crops.ts calls isUrlAllowedByRobotsTxt as a
 *     mandatory pre-flight gate; a genuine Disallow honest-skips and emits the
 *     robots_disallowed audit action via the SSOT constant (no bare literal).
 *
 * This is a P0 standing regression (large-page domain). CI-failing executable
 * invariant. `.skip()` / `.todo()` / `describe.skip` are prohibited.
 *
 * @see apps/mcp-server/src/services/part/crop-persistence.helper.ts (cutCropFromScreenshot)
 * @see apps/mcp-server/scripts/backfill-crops.ts (robots gate + clamp honest-skip)
 * @see apps/mcp-server/src/audit/audit-actions.ts (AUDIT_ACTION_CROP_BACKFILL_ROBOTS_DISALLOWED)
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import { sliceFunctionBody } from "../_setup/slice-function-body";
import { cutCropFromScreenshot } from "../../../../src/services/part/crop-persistence.helper";

const ROBOTS_INV_ID = "INV-CROP-BACKFILL-ROBOTS-001";

const MCP_SERVER_ROOT = path.resolve(__dirname, "../../../../");
const SCRIPT_REL = "scripts/backfill-crops.ts";
const CROP_HELPER_REL = "src/services/part/crop-persistence.helper.ts";
const AUDIT_ACTIONS_REL = "src/audit/audit-actions.ts";

function readRoot(relPath: string): string {
  return fs.readFileSync(path.resolve(MCP_SERVER_ROOT, relPath), "utf8");
}

function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

/** Build a small solid-colour PNG Buffer for the in-range cut test. */
async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 10, g: 120, b: 200 },
    },
  })
    .png()
    .toBuffer();
}

describe("INV-CROP-BACKFILL-CLAMP-HONEST-SKIP: cutCropFromScreenshot clamp-zero/off-screen/NaN → null honest-skip (W6 Issue A PR-4a)", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-CROP-BACKFILL-CLAMP-HONEST-SKIP");
  });

  it("INV-CROP-BACKFILL-CLAMP-HONEST-SKIP: an in-range bbox yields a real PNG crop Buffer", async () => {
    const png = await makePng(200, 200);
    const buf = await cutCropFromScreenshot({
      source: { pngBuffer: png },
      bbox: { x: 10, y: 20, width: 50, height: 40 },
      imgDims: { imgWidth: 200, imgHeight: 200 },
    });
    expect(buf, "in-range bbox must produce a Buffer").not.toBeNull();
    expect(Buffer.isBuffer(buf)).toBe(true);
    // The output is a valid PNG of the requested crop size.
    const meta = await sharp(buf as Buffer).metadata();
    expect(meta.width).toBe(50);
    expect(meta.height).toBe(40);
  });

  it("INV-CROP-BACKFILL-CLAMP-HONEST-SKIP: a fully-off-screen bbox (top >= imgHeight) returns null (honest-skip, no garbage crop)", async () => {
    const png = await makePng(200, 200);
    const buf = await cutCropFromScreenshot({
      source: { pngBuffer: png },
      bbox: { x: 10, y: 500, width: 50, height: 40 },
      imgDims: { imgWidth: 200, imgHeight: 200 },
    });
    expect(buf, "fully-off-screen bbox must honest-skip (null)").toBeNull();
  });

  it("INV-CROP-BACKFILL-CLAMP-HONEST-SKIP: a fully-off-screen bbox (left >= imgWidth) returns null (honest-skip)", async () => {
    const png = await makePng(200, 200);
    const buf = await cutCropFromScreenshot({
      source: { pngBuffer: png },
      bbox: { x: 999, y: 10, width: 50, height: 40 },
      imgDims: { imgWidth: 200, imgHeight: 200 },
    });
    expect(buf, "left >= imgWidth must honest-skip (null)").toBeNull();
  });

  it("INV-CROP-BACKFILL-CLAMP-HONEST-SKIP: a zero-size bbox (width<=0 or height<=0) returns null (honest-skip)", async () => {
    const png = await makePng(200, 200);
    const zeroW = await cutCropFromScreenshot({
      source: { pngBuffer: png },
      bbox: { x: 10, y: 10, width: 0, height: 40 },
      imgDims: { imgWidth: 200, imgHeight: 200 },
    });
    expect(zeroW, "width<=0 must honest-skip (null)").toBeNull();
    const zeroH = await cutCropFromScreenshot({
      source: { pngBuffer: png },
      bbox: { x: 10, y: 10, width: 40, height: 0 },
      imgDims: { imgWidth: 200, imgHeight: 200 },
    });
    expect(zeroH, "height<=0 must honest-skip (null)").toBeNull();
  });

  it("INV-CROP-BACKFILL-CLAMP-HONEST-SKIP: a NaN/Infinity bbox returns null (NaN defense, no garbage crop)", async () => {
    const png = await makePng(200, 200);
    const nanBuf = await cutCropFromScreenshot({
      source: { pngBuffer: png },
      bbox: { x: 10, y: 10, width: Number.NaN, height: 40 },
      imgDims: { imgWidth: 200, imgHeight: 200 },
    });
    expect(nanBuf, "NaN width must honest-skip (null)").toBeNull();
    const infBuf = await cutCropFromScreenshot({
      source: { pngBuffer: png },
      bbox: { x: 10, y: 10, width: 40, height: Number.POSITIVE_INFINITY },
      imgDims: { imgWidth: 200, imgHeight: 200 },
    });
    expect(infBuf, "Infinity height must honest-skip (null)").toBeNull();
  });

  it("INV-CROP-BACKFILL-CLAMP-HONEST-SKIP: a partially-off-screen bbox clamps to the in-viewport region (Buffer, not null)", async () => {
    const png = await makePng(200, 200);
    // top=180 height=100 → clamps to height 20 (200-180). Still a real crop.
    const buf = await cutCropFromScreenshot({
      source: { pngBuffer: png },
      bbox: { x: 10, y: 180, width: 50, height: 100 },
      imgDims: { imgWidth: 200, imgHeight: 200 },
    });
    expect(
      buf,
      "partially-off-screen bbox must clamp + produce a Buffer (not skip)"
    ).not.toBeNull();
    const meta = await sharp(buf as Buffer).metadata();
    expect(meta.height).toBe(20);
  });

  it("INV-CROP-BACKFILL-CLAMP-HONEST-SKIP: backfill-crops.ts persists a crop ONLY when the cut is non-null (no garbage crop when null)", () => {
    const script = stripLineComments(readRoot(SCRIPT_REL));
    // The script must guard the save on a non-null cut buffer (e.g. `if (!cut)` /
    // `cut === null` continue/skip before saveCropFromBuffer).
    expect(
      /cutCropFromScreenshot\b/.test(script),
      "backfill-crops.ts must cut via cutCropFromScreenshot"
    ).toBe(true);
    // A null-guard must precede the persistence (honest-skip path).
    expect(
      /===\s*null|!\s*\w*[Cc]rop|if\s*\(\s*!\s*\w+\s*\)/.test(script),
      "backfill-crops.ts must null-guard the cut before saveCropFromBuffer (no garbage crop on honest-skip)"
    ).toBe(true);
  });
});

describe("INV-CROP-BACKFILL-ROBOTS-001: backfill live re-visit gates on robots.txt (mandatory pre-flight, W6 Issue A PR-4a, F-M-05)", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-CROP-BACKFILL-ROBOTS-001");
  });

  it("INV-CROP-BACKFILL-ROBOTS-001: backfill-crops.ts calls isUrlAllowedByRobotsTxt as a mandatory pre-flight gate (scoped function-slice, no import-line false-GREEN)", () => {
    const script = stripLineComments(readRoot(SCRIPT_REL));
    // A FILE-WIDE `isUrlAllowedByRobotsTxt` regex false-GREENs because the
    // `import { ..., isUrlAllowedByRobotsTxt } from "@reftrixmcp/core"` line survives
    // even if the actual call inside `isRobotsDisallowed` is removed. Slice the
    // `isRobotsDisallowed` body (the robots gate function) so only its in-body
    // robots call satisfies this (TDA-IMPL-PR4A-M-02 / F-M-05, scoped AST-pin).
    const robotsGateBody = sliceFunctionBody(script, "isRobotsDisallowed", ROBOTS_INV_ID);
    expect(
      /\bisUrlAllowedByRobotsTxt\b/.test(robotsGateBody),
      "isRobotsDisallowed must call isUrlAllowedByRobotsTxt (robots re-evaluation on the independent live visit, F-M-05) — the file-wide import line must NOT satisfy this"
    ).toBe(true);
    // The robots gate must be WIRED as a mandatory pre-flight in the per-page flow
    // (processPage), alongside the SSRF gate validateExternalUrl. Slice processPage
    // so a future refactor that drops the wiring (leaving only the helper defs) is RED.
    const processPageBody = sliceFunctionBody(script, "processPage", ROBOTS_INV_ID);
    expect(
      /\bisRobotsDisallowed\b/.test(processPageBody),
      "processPage must wire the isRobotsDisallowed mandatory pre-flight gate (F-M-05) — a defined-but-unwired helper must NOT satisfy this"
    ).toBe(true);
    expect(
      /\bvalidateExternalUrl\b/.test(processPageBody),
      "processPage must also keep the SSRF gate validateExternalUrl wired (defense parity)"
    ).toBe(true);
  });

  it("INV-CROP-BACKFILL-ROBOTS-001: a genuine Disallow (reason === 'disallowed') honest-skips (scoped function-slice, no JSDoc block-comment false-GREEN)", () => {
    const script = stripLineComments(readRoot(SCRIPT_REL));
    // The canonical robots semantic: only reason === "disallowed" is a genuine
    // block; fetch_error is transient and proceeds (Graceful Degradation, parity
    // with section-screenshot-fallback.service.ts). A FILE-WIDE `reason === 'disallowed'`
    // regex false-GREENs because the `/** ... reason === "disallowed" ... *\/` JSDoc
    // **block comment** survives (stripLineComments only strips `//`, NOT `/* *\/`),
    // so neutering the real branch still passes. Slice the `isRobotsDisallowed` body
    // (block comments live outside it) so only the in-body branch satisfies this
    // (TDA-IMPL-PR4A-M-02 / F-M-05, scoped AST-pin).
    const robotsGateBody = sliceFunctionBody(script, "isRobotsDisallowed", ROBOTS_INV_ID);
    expect(
      /reason\s*===\s*["']disallowed["']/.test(robotsGateBody),
      "isRobotsDisallowed must branch on reason === 'disallowed' (genuine Disallow), not a blanket !allowed — the JSDoc block comment must NOT satisfy this"
    ).toBe(true);
  });

  it("INV-CROP-BACKFILL-ROBOTS-001: the robots-disallow honest-skip emits the robots_disallowed audit action via the SSOT constant (no bare literal)", () => {
    const script = stripLineComments(readRoot(SCRIPT_REL));
    const auditActions = stripLineComments(readRoot(AUDIT_ACTIONS_REL));
    // The audit action SSOT constant must exist (GDPR Art.30 robots_disallowed record).
    expect(
      /export\s+const\s+AUDIT_ACTION_CROP_BACKFILL_ROBOTS_DISALLOWED\s*=\s*["']crop_backfill_robots_disallowed["']/.test(
        auditActions
      ),
      "audit-actions.ts must define AUDIT_ACTION_CROP_BACKFILL_ROBOTS_DISALLOWED = 'crop_backfill_robots_disallowed' SSOT"
    ).toBe(true);
    // The actor SSOT constant must exist (system: prefixed, Worker actor naming SSOT).
    expect(
      /export\s+const\s+AUDIT_ACTOR_CROP_BACKFILL\s*=\s*["']system:crop-backfill["']/.test(
        auditActions
      ),
      "audit-actions.ts must define AUDIT_ACTOR_CROP_BACKFILL = 'system:crop-backfill' SSOT"
    ).toBe(true);
    // The script must import + use the SSOT constant (no bare literal hardcode).
    expect(
      /\bAUDIT_ACTION_CROP_BACKFILL_ROBOTS_DISALLOWED\b/.test(script),
      "backfill-crops.ts must emit via the AUDIT_ACTION_CROP_BACKFILL_ROBOTS_DISALLOWED SSOT constant (no bare literal)"
    ).toBe(true);
    expect(
      /\bAUDIT_ACTOR_CROP_BACKFILL\b/.test(script),
      "backfill-crops.ts must emit via the AUDIT_ACTOR_CROP_BACKFILL SSOT constant (no bare actor literal)"
    ).toBe(true);
    // The audit ACTION literal (the SSOT-bound string) must NOT be hardcoded in the
    // script — only the SSOT constant identifier may carry it. (The `details.skipReason`
    // value `"robots_disallowed"` is a descriptive detail field, NOT the action, so it
    // is allowed; the forbidden literal is the action string itself.)
    expect(
      /["']crop_backfill_robots_disallowed["']|["']system:crop-backfill["']/.test(script),
      "backfill-crops.ts must NOT hardcode the robots audit ACTION/ACTOR literal (use the SSOT constants)"
    ).toBe(false);
  });

  it("INV-CROP-BACKFILL-ROBOTS-001: crop helper does not own the robots gate (it lives in the backfill script's per-page flow, not the leaf helper)", () => {
    const helper = stripLineComments(readRoot(CROP_HELPER_REL));
    // The robots gate is a backfill-orchestration concern (the live-visit driver),
    // NOT a crop-cut leaf concern. The helper must stay a pure cut/persist leaf.
    expect(
      /isUrlAllowedByRobotsTxt/.test(helper),
      "crop-persistence.helper.ts must NOT own the robots gate (it belongs to the backfill orchestration script)"
    ).toBe(false);
  });
});
