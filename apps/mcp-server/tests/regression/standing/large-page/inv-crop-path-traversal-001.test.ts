// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-CROP-PATH-TRAVERSAL-001 — crop path traversal SSOT (H, W6 Issue A PR-3a).
 *
 * Context / 背景:
 *   PR-3a adds a NEW allowlist root `<screenshotRoot>/crops/<webPageId>/` and a
 *   `buildSafeCropPath(webPageId, kind, entityId)` helper (now removed; `buildSafeCropDir` remains) that persisted per-section
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
 *
 * Removed surfaces (2026-10-27, internal read API removal): the former surface 4
 * (runtime symlink-escape via `validateCropPath`) and surfaces 5/5b (the crop serve
 * path `getCropStream`) pinned a reader that no longer exists. The symlink-escape
 * runtime defense of the shared core stays covered by
 * `screenshot-persistence.service.test.ts` ("should reject symlinks pointing outside
 * phase5 directory") and surfaces 1/1b here. If a sink that reads crops is ever
 * re-introduced, restore a runtime validator and a symlink-escape test in the same PR
 * (ADR-0052).
 *
 * This is a P0 standing regression (large-page domain). CI-failing executable
 * invariant. `.skip()` / `.todo()` / `describe.skip` are prohibited.
 *
 * @see apps/mcp-server/src/services/part/crop-persistence.helper.ts (buildSafeCropDir)
 * @see apps/mcp-server/src/services/screenshot-persistence.service.ts (shared core)
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
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
      /\bbuildSafePathWithinRoot\b/.test(helper),
      "crop helper must use the shared buildSafePathWithinRoot core (no inline resolver)"
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
  // Surface 3 — webPageId validated via UUID_REGEX
  // ==========================================================================

  it("INV-CROP-PATH-TRAVERSAL-001: surface 3 — buildSafeCropDir validates webPageId via the exported UUID_REGEX (SEC-M-02)", () => {
    const helper = stripLineComments(readSrc(CROP_HELPER_REL));
    expect(
      /\bbuildSafeCropDir\b/.test(helper),
      "crop helper must define buildSafeCropDir(webPageId) (the data.delete cascade path builder)"
    ).toBe(true);
    // UUID_REGEX must be imported from the screenshot SSOT and used to validate
    // webPageId (no bare /^[0-9a-f]{8}.../ literal re-declaration).
    expect(
      /\bUUID_REGEX\b/.test(helper),
      "crop helper must validate webPageId via the exported UUID_REGEX (SEC-M-02)"
    ).toBe(true);
    // Drift guard: no bare RFC-4122 UUID regex literal re-declared in the helper.
    expect(
      /\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/.test(helper),
      "crop helper must NOT re-declare a bare UUID regex literal (use imported UUID_REGEX)"
    ).toBe(false);
  });
});
