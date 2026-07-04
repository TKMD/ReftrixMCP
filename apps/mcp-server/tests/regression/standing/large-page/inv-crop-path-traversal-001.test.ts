// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-CROP-PATH-TRAVERSAL-001 — crop path traversal SSOT (H, W6 Issue A PR-3a).
 *
 * Context / 背景:
 *   PR-3a adds a NEW allowlist root `<screenshotRoot>/crops/<webPageId>/` and a
 *   `buildSafeCropPath(webPageId, kind, entityId)` helper that persists per-section
 *   / per-part viewable PNG crops. The canonical hardened path defense lives in
 *   `screenshot-persistence.service.ts` (`validateScreenshotPath` 5-stage realpath
 *   chain; `buildSafeScreenshotPath` resolve+startsWith). A crops/ sibling dir is
 *   OUTSIDE the hardcoded phase5Dir allowlist, so the crop helper MUST SHARE the
 *   same realpath+isFile+startsWith core (parameterized by `allowlistDir`) — NOT a
 *   weaker 2nd resolver (SEC-H-02 ≡ TDA-08). FILE_MODE/DIR_MODE MUST come from the
 *   shared core, never re-declared literals (TDA-02). webPageId/entityId are
 *   validated via the exported `UUID_REGEX` directly (SEC-M-02).
 *
 * Invariant / 不変条件 (AST source-pin, NO testcontainer / Redis / DB — same
 * deterministic style as INV-SECTION-VISUAL-SKIP-REASON-CLEAR-001):
 *   - surface 1: the shared traversal-defense core is parameterized by an
 *     `allowlistDir` argument (a single startsWith+realpath core, not duplicated).
 *   - surface 2: the crop helper imports the screenshot SSOT (UUID_REGEX +
 *     shared validate/build core) — it does NOT inline its own startsWith/realpath
 *     resolver and does NOT re-declare 0o600 / 0o700 literals.
 *   - surface 3: the crop helper validates webPageId AND entityId via UUID_REGEX
 *     (no bare UUID literal, no path.resolve+startsWith without realpath).
 *   - surface 4 (runtime): a symlink-escape candidate resolves to null via the
 *     shared validator (real defense exercised, not just source-pinned).
 *
 * This is a P0 standing regression (large-page domain). CI-failing executable
 * invariant. `.skip()` / `.todo()` / `describe.skip` are prohibited.
 *
 * @see apps/mcp-server/src/services/part/crop-persistence.helper.ts (buildSafeCropPath)
 * @see apps/mcp-server/src/services/screenshot-persistence.service.ts (shared core)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertInvName } from "../_setup/inv-assert";

const MCP_SERVER_SRC_ROOT = path.resolve(__dirname, "../../../../src");

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(MCP_SERVER_SRC_ROOT, relPath), "utf8");
}

/** Strip single-line `//` comments before source-pin matching. */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

const CROP_HELPER_REL = "services/part/crop-persistence.helper.ts";
const SCREENSHOT_SVC_REL = "services/screenshot-persistence.service.ts";

describe("INV-CROP-PATH-TRAVERSAL-001: crop path traversal shares the screenshot SSOT realpath+isFile+startsWith core (W6 Issue A PR-3a)", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-CROP-PATH-TRAVERSAL-001");
  });

  // ==========================================================================
  // Surface 1 — shared traversal core is parameterized by allowlistDir
  // ==========================================================================

  it("INV-CROP-PATH-TRAVERSAL-001: surface 1 — screenshot-persistence exports a shared traversal-defense core parameterized by an allowlistDir argument", () => {
    const svc = stripLineComments(readSrc(SCREENSHOT_SVC_REL));
    // The 5-stage realpath chain must be extracted into a shared helper that takes
    // an `allowlistDir` argument so the crops/ sibling dir reuses it with zero
    // duplication. Pin both the exported validate-within-root and build-within-root
    // cores by their allowlistDir-parameterized signatures.
    const validateWithinRoot =
      /export\s+async\s+function\s+validatePathWithinRoot\s*\(\s*candidatePath\s*:\s*string\s*,\s*allowlistDir\s*:\s*string\s*\)/;
    const buildWithinRoot =
      /export\s+(?:async\s+)?function\s+buildSafePathWithinRoot\s*\(\s*allowlistDir\s*:\s*string\s*,/;
    expect(
      validateWithinRoot.test(svc),
      "screenshot-persistence must export `validatePathWithinRoot(candidatePath, allowlistDir)` (shared realpath+isFile+startsWith core)"
    ).toBe(true);
    expect(
      buildWithinRoot.test(svc),
      "screenshot-persistence must export `buildSafePathWithinRoot(allowlistDir, ...)` (shared resolve+startsWith core)"
    ).toBe(true);
  });

  it("INV-CROP-PATH-TRAVERSAL-001: surface 1b — the screenshot path API (validateScreenshotPath / buildSafeScreenshotPath) still exists as thin wrappers over the shared core (no regression)", () => {
    const svc = stripLineComments(readSrc(SCREENSHOT_SVC_REL));
    expect(
      /export\s+async\s+function\s+validateScreenshotPath\s*\(/.test(svc),
      "validateScreenshotPath public API must be preserved (thin wrapper)"
    ).toBe(true);
    // The wrappers must DELEGATE to the shared core (not duplicate the realpath chain).
    expect(
      /validatePathWithinRoot\s*\(/.test(svc),
      "validateScreenshotPath must delegate to the shared validatePathWithinRoot core"
    ).toBe(true);
    expect(
      /buildSafePathWithinRoot\s*\(/.test(svc),
      "buildSafeScreenshotPath must delegate to the shared buildSafePathWithinRoot core"
    ).toBe(true);
  });

  // ==========================================================================
  // Surface 2 — crop helper imports SSOT, no inline resolver, no mode literals
  // ==========================================================================

  it("INV-CROP-PATH-TRAVERSAL-001: surface 2 — crop helper imports the screenshot SSOT shared core (no weak 2nd resolver)", () => {
    const helper = stripLineComments(readSrc(CROP_HELPER_REL));
    // The crop helper MUST import the shared validate/build core from the
    // screenshot SSOT (single-source). A weak inline resolver = drift surface.
    expect(
      /from\s+["'][^"']*screenshot-persistence\.service["']/.test(helper),
      "crop helper must import from screenshot-persistence.service (shared SSOT core)"
    ).toBe(true);
    expect(
      /\bbuildSafePathWithinRoot\b/.test(helper) || /\bvalidatePathWithinRoot\b/.test(helper),
      "crop helper must use the shared buildSafePathWithinRoot / validatePathWithinRoot core (no inline resolver)"
    ).toBe(true);
  });

  it("INV-CROP-PATH-TRAVERSAL-001: surface 2b — crop helper does NOT re-declare FILE_MODE/DIR_MODE literals (TDA-02 shared-core mandate)", () => {
    const helper = stripLineComments(readSrc(CROP_HELPER_REL));
    // 0o600 / 0o700 literals must come from the shared core (imported), never
    // re-declared in the crop helper (2nd duplication surface = drift).
    expect(
      /\b0o600\b/.test(helper),
      "crop helper must NOT re-declare the 0o600 FILE_MODE literal (import from shared core)"
    ).toBe(false);
    expect(
      /\b0o700\b/.test(helper),
      "crop helper must NOT re-declare the 0o700 DIR_MODE literal (import from shared core)"
    ).toBe(false);
  });

  it("INV-CROP-PATH-TRAVERSAL-001: surface 2c — crop helper does NOT contain its own raw fs.realpath/startsWith allowlist resolver (single-source)", () => {
    const helper = stripLineComments(readSrc(CROP_HELPER_REL));
    // A second `.startsWith(<dir> + path.sep)` allowlist check inside the helper
    // would be a weak duplicate resolver. The allowlist gate must live ONLY in the
    // shared core the helper delegates to.
    expect(
      /\.startsWith\([^)]*path\.sep/.test(helper),
      "crop helper must NOT implement its own startsWith allowlist resolver (delegate to shared core)"
    ).toBe(false);
  });

  // ==========================================================================
  // Surface 3 — webPageId AND entityId validated via UUID_REGEX
  // ==========================================================================

  it("INV-CROP-PATH-TRAVERSAL-001: surface 3 — buildSafeCropPath validates webPageId and entityId via the exported UUID_REGEX (SEC-M-02)", () => {
    const helper = stripLineComments(readSrc(CROP_HELPER_REL));
    expect(
      /\bbuildSafeCropPath\b/.test(helper),
      "crop helper must define buildSafeCropPath(webPageId, kind, entityId)"
    ).toBe(true);
    // UUID_REGEX must be imported from the screenshot SSOT and used to validate
    // BOTH webPageId and entityId (no bare /^[0-9a-f]{8}.../ literal re-declaration).
    expect(
      /\bUUID_REGEX\b/.test(helper),
      "crop helper must validate webPageId/entityId via the exported UUID_REGEX (SEC-M-02)"
    ).toBe(true);
    // Drift guard: no bare RFC-4122 UUID regex literal re-declared in the helper.
    expect(
      /\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/.test(helper),
      "crop helper must NOT re-declare a bare UUID regex literal (use imported UUID_REGEX)"
    ).toBe(false);
  });

  // ==========================================================================
  // Surface 4 — runtime symlink-escape resolves to null (real defense)
  // ==========================================================================

  describe("runtime symlink-escape via the shared crop validator", () => {
    let tmpRoot: string;
    let outsideTarget: string;

    beforeEach(async () => {
      tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "inv-crop-traversal-"));
      process.env.REFTRIX_SCREENSHOT_ROOT = tmpRoot;
      outsideTarget = path.join(tmpRoot, "outside-secret.png");
      await fs.promises.writeFile(outsideTarget, Buffer.from("secret"));
    });

    afterEach(async () => {
      delete process.env.REFTRIX_SCREENSHOT_ROOT;
      const mod = await import("../../../../src/services/screenshot-persistence.service");
      mod.clearResolvedRootCache();
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    });

    it("INV-CROP-PATH-TRAVERSAL-001: surface 4 — a symlink inside the crop dir pointing outside the crop root resolves to null via validateCropPath", async () => {
      const cropMod = await import("../../../../src/services/part/crop-persistence.helper");
      const webPageId = "0193b1e2-7c3a-7def-8a01-0123456789ab";
      const cropRoot = await cropMod.resolveCropRoot();
      const perPageDir = path.join(cropRoot, webPageId);
      await fs.promises.mkdir(perPageDir, { recursive: true });
      const symlinkPath = path.join(perPageDir, "section-escape.png");
      // symlink escapes the crop root → must resolve to null (realpath re-check)
      await fs.promises.symlink(outsideTarget, symlinkPath);

      const resolved = await cropMod.validateCropPath(symlinkPath);
      expect(
        resolved,
        "a symlink escaping the crop root MUST resolve to null (realpath re-check, not a weak resolver)"
      ).toBeNull();
    });
  });

  // ==========================================================================
  // Surface 5 — crop SERVE route source-pin (W6 Issue A PR-4a, F-H-01, F-L-05)
  //
  // The PR-4 serve route (`getCropStream` in page-detail.service.ts) reads the
  // DB-first `crop_storage_path` then chains `validateCropPath` BEFORE
  // `createReadStream`. This surface CI-RED's if the serve path lets a raw DB
  // crop path reach the filesystem without the realpath validator (raw-path→fs
  // callsite=0 AST-pin), or if the validator is dropped. This EXTENDS the
  // existing file's surfaces 1-4 (NOT a new file, F-L-05).
  // ==========================================================================

  const PAGE_DETAIL_REL = "api/internal/page-detail.service.ts";

  it("INV-CROP-PATH-TRAVERSAL-001: surface 5 — the crop serve path (getCropStream) chains validateCropPath before createReadStream (no weak 2nd resolver)", () => {
    const pageDetail = stripLineComments(readSrc(PAGE_DETAIL_REL));
    // getCropStream must exist and must reference the crop realpath validator SSOT.
    expect(
      /export\s+async\s+function\s+getCropStream\s*\(/.test(pageDetail),
      "page-detail.service.ts must export getCropStream (the crop serve resolver)"
    ).toBe(true);
    expect(
      /\bvalidateCropPath\s*\(/.test(pageDetail),
      "getCropStream must chain validateCropPath (realpath+isFile+startsWith SSOT) before reading"
    ).toBe(true);
  });

  it("INV-CROP-PATH-TRAVERSAL-001: surface 5b — 0 raw crop_storage_path → fs/createReadStream callsites in the crop serve path (source-pin)", () => {
    const pageDetail = stripLineComments(readSrc(PAGE_DETAIL_REL));
    // No raw DB column value may flow directly into a filesystem read. The crop
    // serve must only feed createReadStream the validated `safe`/`validated` local,
    // never a raw `crop_storage_path` / `cropStoragePath` row value.
    const RAW_PATH_TO_FS_RE = /createReadStream\s*\(\s*[^)]*(?:crop_storage_path|cropStoragePath)/;
    expect(
      RAW_PATH_TO_FS_RE.test(pageDetail),
      "raw crop_storage_path must NOT flow directly into createReadStream (route through validateCropPath)"
    ).toBe(false);
  });
});
