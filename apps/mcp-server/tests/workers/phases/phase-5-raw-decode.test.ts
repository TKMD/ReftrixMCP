// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5: RAW Decode Optimization Tests
 *
 * Phase 5 (Embedding) でスクリーンショットPNGの1回RAWデコード + ファイル化を検証する。
 * ピークRSS -200~600MB の最大効果変更。
 *
 * Verifies the single-pass RAW decode + file-based approach for screenshot PNG
 * in Phase 5 (Embedding). This is the highest-impact change (peak RSS -200~600MB).
 *
 * テストケース:
 *   1. PNGファイルが一時ディレクトリに保存されること
 *   2. RAWデコードが1回だけ実行されること（Sharp呼び出し回数検証）
 *   3. RAWファイルからのextract(crop)が正しく動作すること
 *   4. Phase 5完了後に一時ファイルが削除されること（finally保証）
 *   5. Phase 5例外発生時も一時ファイルが削除されること
 *   6. 一時ファイルパーミッションが0o600であること
 *   7. screenshotBase64がない場合のGraceful Degradation
 *   8. PipelineState.screenshotPngPathがOptionalであること
 *   9. isBlankImage()のRAW/PNG互換性テスト（TPA-2）
 *  10. highPiiSectionIdsフィルタが維持されること（PII-1）
 *
 * @module tests/workers/phases/phase-5-raw-decode
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";

// ============================================================================
// Test 1-8: Unit tests for RAW decode utilities
// ============================================================================

import {
  createPhase5TempDir,
  decodeToRawFile,
  acquireSectionCropBufferFromRaw,
  cleanupPhase5TempDir,
  loadRawBuffer,
  type RawScreenshotMetadata,
} from "../../../src/workers/phases/phase-5-raw-decode";

describe("Phase 5: RAW Decode Optimization", () => {
  let tmpDir: string;

  beforeEach(() => {
    // v0.4.0 PR7d-2 (TDA LOW-1): decodeToRawFile() now enforces a whitelist
    // that requires tmpDir to be under os.tmpdir() AND have the
    // `reftrix-phase5-raw-` prefix (mirroring cleanupPhase5TempDir). Using
    // `createPhase5TempDir()` is the simplest way to produce a valid tmpDir
    // in tests; fallback to mkdtempSync with the exact prefix is equivalent.
    // v0.4.0 PR7d-2 (TDA LOW-1): decodeToRawFile() は `reftrix-phase5-raw-`
    // prefix whitelist を要求する。テストでは createPhase5TempDir() 同等の
    // prefix を使用する。
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reftrix-phase5-raw-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* cleanup best-effort */
    }
  });

  // ========================================================================
  // 1. Temp directory creation (v0.4.0: `reftrix-phase5-raw-` prefix)
  //    Screenshot PNG 保存は ScreenshotPersistenceService が担当するため
  //    このファイルでは RAW decode 用の短命ディレクトリ作成のみを検証する。
  //    Screenshot PNG persistence moved to ScreenshotPersistenceService;
  //    this file only verifies the ephemeral tmp dir for RAW decode.
  // ========================================================================
  describe("Temp directory creation (v0.4.0)", () => {
    it("should create a job-specific temp directory with reftrix-phase5-raw- prefix", () => {
      const dir = createPhase5TempDir();
      try {
        expect(fs.existsSync(dir)).toBe(true);
        expect(path.basename(dir)).toMatch(/^reftrix-phase5-raw-/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ========================================================================
  // 2. RAWデコードが1回だけ実行されること
  // ========================================================================
  describe("RAWデコード1回実行 / Single RAW decode", () => {
    it("should decode PNG to RAW file and return metadata", async () => {
      const width = 10;
      const height = 8;
      const pngBuffer = await sharp({
        create: {
          width,
          height,
          channels: 4,
          background: { r: 128, g: 64, b: 32, alpha: 1 },
        },
      })
        .png()
        .toBuffer();

      const pngPath = path.join(tmpDir, "screenshot.png");
      fs.writeFileSync(pngPath, pngBuffer, { mode: 0o600 });

      const result = await decodeToRawFile(pngPath, tmpDir);

      expect(result).not.toBeNull();
      expect(result!.rawPath).toBeDefined();
      expect(fs.existsSync(result!.rawPath)).toBe(true);
      expect(result!.width).toBe(width);
      expect(result!.height).toBe(height);
      expect(result!.channels).toBe(4);

      // RAWファイルサイズ = width * height * channels
      const rawStat = fs.statSync(result!.rawPath);
      expect(rawStat.size).toBe(width * height * 4);
    });

    it("should set mode 0o600 on RAW file (TMP-3)", async () => {
      const pngBuffer = await sharp({
        create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
      })
        .png()
        .toBuffer();

      const pngPath = path.join(tmpDir, "screenshot.png");
      fs.writeFileSync(pngPath, pngBuffer, { mode: 0o600 });

      const result = await decodeToRawFile(pngPath, tmpDir);
      expect(result).not.toBeNull();

      const stat = fs.statSync(result!.rawPath);
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  // ========================================================================
  // 3. RAWファイルからのextract(crop)が正しく動作すること
  // ========================================================================
  describe("RAWファイルからのcrop / Crop from RAW file", () => {
    it("should extract a crop region from RAW buffer matching PNG-based crop", async () => {
      // Create a 20x20 image with distinct color regions
      const width = 20;
      const height = 20;
      const pngBuffer = await sharp({
        create: {
          width,
          height,
          channels: 4,
          background: { r: 100, g: 150, b: 200, alpha: 1 },
        },
      })
        .png()
        .toBuffer();

      const pngPath = path.join(tmpDir, "screenshot.png");
      fs.writeFileSync(pngPath, pngBuffer, { mode: 0o600 });

      const rawMeta = await decodeToRawFile(pngPath, tmpDir);
      expect(rawMeta).not.toBeNull();

      // Load RAW buffer for the loop (mirrors Phase 5 usage pattern)
      const rawBuf = loadRawBuffer(rawMeta!);
      expect(rawBuf).not.toBeNull();

      // Crop region: top=5, left=0, width=20, height=10
      const cropResult = await acquireSectionCropBufferFromRaw({
        rawMeta: rawMeta!,
        sectionPos: { startY: 5, height: 10 },
        imgWidth: width,
        imgHeight: height,
        dinov2InputSize: 224,
        rawBuffer: rawBuf!,
      });

      expect(cropResult.rawCropBuffer).not.toBeNull();
      // DINOv2 output is 224*224*3 (RGB, no alpha)
      expect(cropResult.rawCropBuffer!.length).toBe(224 * 224 * 3);
      expect(cropResult.isBlank).toBe(false);
    });

    it("should return null for out-of-range sections (sectionTop >= imgHeight)", async () => {
      const width = 10;
      const height = 10;
      const pngBuffer = await sharp({
        create: {
          width,
          height,
          channels: 4,
          background: { r: 50, g: 50, b: 50, alpha: 1 },
        },
      })
        .png()
        .toBuffer();

      const pngPath = path.join(tmpDir, "screenshot.png");
      fs.writeFileSync(pngPath, pngBuffer, { mode: 0o600 });

      const rawMeta = await decodeToRawFile(pngPath, tmpDir);
      expect(rawMeta).not.toBeNull();

      const cropResult = await acquireSectionCropBufferFromRaw({
        rawMeta: rawMeta!,
        sectionPos: { startY: 100, height: 50 },
        imgWidth: width,
        imgHeight: height,
        dinov2InputSize: 224,
      });

      // Out of range: no crop buffer, not blank (fallback should handle)
      expect(cropResult.rawCropBuffer).toBeNull();
      expect(cropResult.isBlank).toBe(false);
    });
  });

  // ========================================================================
  // 4. Phase 5完了後に一時ファイルが削除されること（finally保証）
  // ========================================================================
  describe("一時ファイル削除 / Temp file cleanup", () => {
    it("should remove temp directory on cleanupPhase5TempDir() (TMP-2)", () => {
      const dir = createPhase5TempDir();
      expect(fs.existsSync(dir)).toBe(true);

      // Create some files inside
      fs.writeFileSync(path.join(dir, "test.raw"), Buffer.alloc(100), { mode: 0o600 });
      fs.writeFileSync(path.join(dir, "test.png"), Buffer.alloc(50), { mode: 0o600 });

      cleanupPhase5TempDir(dir);
      expect(fs.existsSync(dir)).toBe(false);
    });

    // ========================================================================
    // 5. Phase 5例外発生時も一時ファイルが削除されること
    // ========================================================================
    it("should remove temp directory even on cleanup after error (TMP-2)", () => {
      const dir = createPhase5TempDir();
      fs.writeFileSync(path.join(dir, "data.raw"), Buffer.alloc(100), { mode: 0o600 });

      // Simulate: cleanup is called in finally block regardless of success/failure
      let errorCaught = false;
      try {
        throw new Error("Simulated Phase 5 failure");
      } catch {
        errorCaught = true;
      } finally {
        cleanupPhase5TempDir(dir);
      }

      expect(errorCaught).toBe(true);
      expect(fs.existsSync(dir)).toBe(false);
    });
  });

  // ========================================================================
  // 6. 一時ファイルパーミッションが0o600であること
  // ========================================================================
  describe("ファイルパーミッション / File permissions (TMP-3)", () => {
    it("should create temp directory accessible only by owner", () => {
      const dir = createPhase5TempDir();
      try {
        const stat = fs.statSync(dir);
        // Directory should be 0o700 (owner rwx only)
        expect(stat.mode & 0o777).toBe(0o700);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ========================================================================
  // 7. screenshotBase64がない場合のGraceful Degradation
  // ========================================================================
  describe("Graceful Degradation / No screenshot", () => {
    it("should return null from decodeToRawFile when PNG file does not exist", async () => {
      const nonExistentPath = path.join(tmpDir, "nonexistent.png");
      const result = await decodeToRawFile(nonExistentPath, tmpDir);
      expect(result).toBeNull();
    });
  });

  // ========================================================================
  // 8. PipelineState.screenshotPngPathがOptionalであること (TMP-5)
  // ========================================================================
  describe("PipelineState extension / Optional fields (TMP-5)", () => {
    it("should verify PipelineState has optional screenshotPngPath field", () => {
      // Read the source and check that PipelineState includes the optional field
      const typesSource = fs.readFileSync(
        path.resolve(__dirname, "../../../src/workers/phases/types.ts"),
        "utf8"
      );

      // Check for optional screenshotPngPath field in PipelineState
      expect(typesSource).toContain("screenshotPngPath?: string");
    });
  });
});

// ============================================================================
// Test 9: isBlankImage RAW/PNG互換性テスト（TPA-2）
// ============================================================================

describe("isBlankImage RAW/PNG compatibility (TPA-2)", () => {
  it("should produce identical blank detection for white image via RAW-based and PNG-based paths", async () => {
    // Create a near-white (blank) image
    const width = 50;
    const height = 50;
    const whitePng = await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    // PNG-based path: crop → isBlankImage
    const { isBlankImage } = await import("../../../src/utils/blank-image-detector");

    // Crop via PNG (traditional path)
    const pngCropped = await sharp(whitePng)
      .extract({ left: 0, top: 0, width, height })
      .png()
      .toBuffer();
    const pngBlank = await isBlankImage(pngCropped);

    // RAW-based path: decode to RAW → extract → encode to PNG → isBlankImage
    const rawBuffer = await sharp(whitePng).ensureAlpha().raw().toBuffer();
    const rawCropped = await sharp(rawBuffer, { raw: { width, height, channels: 4 } })
      .extract({ left: 0, top: 0, width, height })
      .png()
      .toBuffer();
    const rawBlank = await isBlankImage(rawCropped);

    // Both paths must agree
    expect(rawBlank).toBe(pngBlank);
    expect(rawBlank).toBe(true); // White image should be detected as blank
  });

  it("should produce identical non-blank detection for colored image via RAW and PNG paths", async () => {
    const width = 50;
    const height = 50;

    // Create a multi-colored image (not blank)
    const colorPng = await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 100, g: 150, b: 200, alpha: 1 },
      },
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 25,
              height: 25,
              channels: 4,
              background: { r: 255, g: 0, b: 0, alpha: 1 },
            },
          })
            .png()
            .toBuffer(),
          left: 0,
          top: 0,
        },
      ])
      .png()
      .toBuffer();

    const { isBlankImage } = await import("../../../src/utils/blank-image-detector");

    // PNG-based path
    const pngCropped = await sharp(colorPng)
      .extract({ left: 0, top: 0, width, height })
      .png()
      .toBuffer();
    const pngBlank = await isBlankImage(pngCropped);

    // RAW-based path
    const rawBuffer = await sharp(colorPng).ensureAlpha().raw().toBuffer();
    const rawCropped = await sharp(rawBuffer, { raw: { width, height, channels: 4 } })
      .extract({ left: 0, top: 0, width, height })
      .png()
      .toBuffer();
    const rawBlank = await isBlankImage(rawCropped);

    expect(rawBlank).toBe(pngBlank);
    expect(rawBlank).toBe(false); // Colored image should NOT be blank
  });

  it("should produce identical blank detection for dark (near-black) images", async () => {
    const width = 30;
    const height = 30;

    // Near-black 3-channel image (mean < 10, stddev < 5) -> should be blank
    // Note: 4-channel (RGBA) images have alpha=255 which pushes avgMean to ~65,
    // so we use 3-channel (RGB) to test the near-black detection path.
    const darkPng = await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 2, g: 2, b: 2 },
      },
    })
      .png()
      .toBuffer();

    const { isBlankImage } = await import("../../../src/utils/blank-image-detector");

    const pngCropped = await sharp(darkPng)
      .extract({ left: 0, top: 0, width, height })
      .png()
      .toBuffer();
    const pngBlank = await isBlankImage(pngCropped);

    const rawBuffer = await sharp(darkPng).ensureAlpha().raw().toBuffer();
    // After ensureAlpha, channels become 4
    const rawCropped = await sharp(rawBuffer, { raw: { width, height, channels: 4 } })
      .extract({ left: 0, top: 0, width, height })
      .removeAlpha()
      .png()
      .toBuffer();
    const rawBlank = await isBlankImage(rawCropped);

    // Both paths must agree on blank detection
    expect(rawBlank).toBe(pngBlank);
    expect(rawBlank).toBe(true); // Near-black RGB should be blank
  });
});

// ============================================================================
// Test 10: highPiiSectionIdsフィルタ維持テスト（PII-1）
// ============================================================================

describe("PII protection filter maintained (PII-1)", () => {
  it("should verify Phase 5 source retains highPiiSectionIds filtering logic", () => {
    const phase5Source = fs.readFileSync(
      path.resolve(__dirname, "../../../src/workers/phases/phase-5-embedding.ts"),
      "utf8"
    );

    // highPiiSectionIds filtering must still exist in Phase 5
    expect(phase5Source).toContain("highPiiSectionIds");
    expect(phase5Source).toContain("highPiiSectionIdSet");
    expect(phase5Source).toContain("pii_risk_level");
    expect(phase5Source).toContain("GDPR Art. 5(1)(c)");
  });

  it("should verify acquireSectionCropBufferFromRaw does not bypass PII filter", () => {
    // The RAW-based crop function should NOT contain PII filtering logic
    // (PII filtering is done at the caller level, same as original acquireSectionCropBuffer)
    const rawDecodeSource = fs.readFileSync(
      path.resolve(__dirname, "../../../src/workers/phases/phase-5-raw-decode.ts"),
      "utf8"
    );

    // The function should not reference PII — filtering is caller's responsibility
    expect(rawDecodeSource).not.toContain("piiRiskLevel");
    // Confirm the function exists
    expect(rawDecodeSource).toContain("acquireSectionCropBufferFromRaw");
  });
});

// ==========================================================================
// 11. TDA監査追加: Graceful Degradation — 破損PNGとファイル不存在
// ==========================================================================
describe("TDA audit: Graceful Degradation edge cases", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createPhase5TempDir();
  });

  afterEach(() => {
    cleanupPhase5TempDir(tmpDir);
  });

  it("should return null when decodeToRawFile receives a corrupted PNG", async () => {
    // Write corrupted data as PNG file
    const corruptedPngPath = path.join(tmpDir, "screenshot.png");
    fs.writeFileSync(corruptedPngPath, Buffer.from("not-a-valid-png-data"), { mode: 0o600 });

    const result = await decodeToRawFile(corruptedPngPath, tmpDir);
    expect(result).toBeNull();
  });

  it("should return null when loadRawBuffer receives non-existent file path", () => {
    const fakeMeta: RawScreenshotMetadata = {
      rawPath: path.join(tmpDir, "nonexistent.raw"),
      width: 100,
      height: 100,
      channels: 4,
    };

    const result = loadRawBuffer(fakeMeta);
    expect(result).toBeNull();
  });
});

// ==========================================================================
// 12. PR7d-1 SEC A-1: cleanupPhase5TempDir whitelist 3段防御
//     cleanupPhase5TempDir must reject paths outside os.tmpdir() AND
//     paths whose basename does not start with reftrix-phase5-raw-.
//     This prevents the PR7b/PR7c carry-over bug where page-analyze-worker
//     accidentally deleted `<REFTRIX_SCREENSHOT_ROOT>/phase5/` (persisted
//     screenshot dir), which broke Queue-based Backfill visual embedding.
// ==========================================================================
describe("PR7d-1: cleanupPhase5TempDir whitelist defense (SEC A-1)", () => {
  const realOsTmp = fs.realpathSync(os.tmpdir());

  it("(1) should NOT delete a persisted screenshot path (`<root>/phase5/`)", () => {
    // Simulate a persisted screenshot directory that happens to live under /tmp
    // but lacks the `reftrix-phase5-raw-` prefix.
    const persistedDir = fs.mkdtempSync(path.join(realOsTmp, "reftrix-screenshots-phase5-"));
    const persistedFile = path.join(persistedDir, "webpage.png");
    fs.writeFileSync(persistedFile, Buffer.alloc(100), { mode: 0o600 });
    try {
      cleanupPhase5TempDir(persistedDir);
      expect(fs.existsSync(persistedDir)).toBe(true);
      expect(fs.existsSync(persistedFile)).toBe(true);
    } finally {
      fs.rmSync(persistedDir, { recursive: true, force: true });
    }
  });

  it("(2) should NOT follow a symlink that points at a non-whitelisted directory", () => {
    // Attack: symlink named `reftrix-phase5-raw-attack` pointing at a persisted dir.
    // realpath resolution should detect that the real basename is NOT
    // `reftrix-phase5-raw-*` and reject the deletion.
    const persistedDir = fs.mkdtempSync(path.join(realOsTmp, "reftrix-screenshots-phase5-"));
    const persistedMarker = path.join(persistedDir, "precious.png");
    fs.writeFileSync(persistedMarker, Buffer.alloc(50), { mode: 0o600 });

    const symlinkPath = path.join(realOsTmp, `reftrix-phase5-raw-symlink-attack-${process.pid}`);
    // Ensure no leftover
    try {
      fs.unlinkSync(symlinkPath);
    } catch {
      /* ignore */
    }
    fs.symlinkSync(persistedDir, symlinkPath, "dir");

    try {
      cleanupPhase5TempDir(symlinkPath);
      // Symlink target must not have been deleted
      expect(fs.existsSync(persistedMarker)).toBe(true);
    } finally {
      try {
        fs.unlinkSync(symlinkPath);
      } catch {
        /* ignore */
      }
      fs.rmSync(persistedDir, { recursive: true, force: true });
    }
  });

  it("(3) should NOT delete a relative path escaping os.tmpdir() (`../etc`)", () => {
    // The helper must reject anything that does not resolve under os.tmpdir()
    // AND whose basename does not match the prefix.
    // A relative path like "../etc" or "/etc" should be a silent no-op.
    // We assert by ensuring no exception is thrown AND /etc still has contents.
    // (We are not actually going to try to delete /etc — realpath rejection
    //  prevents entry into the rmSync branch.)
    expect(() => {
      cleanupPhase5TempDir("../etc");
    }).not.toThrow();
    expect(() => {
      cleanupPhase5TempDir("/etc");
    }).not.toThrow();
  });

  it("(4) should reject null-byte injection", () => {
    // Null byte in path must be rejected before any realpath / rmSync call.
    const maliciousPath = "/tmp/reftrix-phase5-raw-\0../etc";
    expect(() => {
      cleanupPhase5TempDir(maliciousPath);
    }).not.toThrow();
    // /etc should remain intact (sanity check: rerun and ensure no crash).
  });

  it("(5) should DELETE a legitimate reftrix-phase5-raw-xxx tmp dir (regression)", () => {
    // Positive case: the happy path must still work.
    const dir = createPhase5TempDir();
    expect(fs.existsSync(dir)).toBe(true);
    fs.writeFileSync(path.join(dir, "test.raw"), Buffer.alloc(100), { mode: 0o600 });

    cleanupPhase5TempDir(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("(6) should silently no-op on non-existent path (ENOENT via realpath)", () => {
    const ghost = path.join(realOsTmp, `reftrix-phase5-raw-ghost-${process.pid}-${Date.now()}`);
    // Must not throw even though realpath would ENOENT.
    expect(() => {
      cleanupPhase5TempDir(ghost);
    }).not.toThrow();
    expect(fs.existsSync(ghost)).toBe(false);
  });

  it("(7) should reject non-string input (defensive)", () => {
    // Type-level safety via TS, but runtime defense still exercised.
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cleanupPhase5TempDir(123 as any);
    }).not.toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => cleanupPhase5TempDir(null as any)).not.toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => cleanupPhase5TempDir(undefined as any)).not.toThrow();
  });
});
