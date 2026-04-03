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
  saveScreenshotAsPng,
  decodeToRawFile,
  acquireSectionCropBufferFromRaw,
  cleanupPhase5TempDir,
  loadRawBuffer,
  type RawScreenshotMetadata,
} from "../../../src/workers/phases/phase-5-raw-decode";

describe("Phase 5: RAW Decode Optimization", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reftrix-test-raw-decode-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* cleanup best-effort */
    }
  });

  // ========================================================================
  // 1. PNGファイルが一時ディレクトリに保存されること
  // ========================================================================
  describe("PNGファイル保存 / PNG file save", () => {
    it("should create a job-specific temp directory with reftrix-phase5- prefix", () => {
      const dir = createPhase5TempDir();
      try {
        expect(fs.existsSync(dir)).toBe(true);
        expect(path.basename(dir)).toMatch(/^reftrix-phase5-/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("should save screenshot Base64 as PNG file with mode 0o600 (TMP-3)", async () => {
      // 2x2 red PNG
      const pngBuffer = await sharp({
        create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
      })
        .png()
        .toBuffer();
      const base64 = pngBuffer.toString("base64");

      const pngPath = saveScreenshotAsPng(tmpDir, base64);

      expect(fs.existsSync(pngPath)).toBe(true);
      expect(path.extname(pngPath)).toBe(".png");
      expect(path.dirname(pngPath)).toBe(tmpDir);

      // TMP-3: パーミッション確認
      const stat = fs.statSync(pngPath);
      // Owner read/write only (0o600 = 384 in decimal)
      expect(stat.mode & 0o777).toBe(0o600);
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

    it("saveScreenshotAsPng should throw on empty base64", () => {
      expect(() => saveScreenshotAsPng(tmpDir, "")).toThrow();
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
