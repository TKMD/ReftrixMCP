// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5: RAW Decode Optimization
 *
 * スクリーンショットPNGの1回RAWデコード + ファイル化によるメモリ最適化。
 * 従来: 毎セクション sharp(screenshotBuffer) → PNG全体をRGBAデコード（230MB/回）
 * 改善: 1回だけ PNG → RAW デコード → 以降は sharp(rawBuffer, {raw:...}).extract() で
 *       PNG デコード不要（0回）。RAW バッファは既にデコード済みなので extract() は
 *       バッファ内のオフセット計算のみで完了する。
 *
 * Single-pass RAW decode optimization for Phase 5 (Embedding).
 * Before: sharp(pngBuffer) per section → full PNG RGBA decode (~230MB each)
 * After: single PNG → RAW decode → sharp(rawBuffer, {raw:...}).extract() with zero PNG decode
 *
 * RAW ファイルへの永続化は、Phase 5 サブフェーズ間（section visual → part visual）で
 * RAW バッファをメモリから解放し、必要時に再読み込みするために使用する。
 *
 * RAW file persistence is used to release the RAW buffer from memory between
 * Phase 5 sub-phases (section visual → part visual) and reload when needed.
 *
 * TMP-1: fs.mkdtempSync(path.join(os.tmpdir(), 'reftrix-phase5-')) でジョブ固有ディレクトリ
 * TMP-2: finally ブロックで fs.rmSync(tmpDir, {recursive: true, force: true}) 確実実行
 * TMP-3: ファイル作成時 mode: 0o600
 * TMP-4: パスはユーザー入力から構成しない（内部生成のみ）
 * TMP-5: PipelineState への追加フィールドは Optional 型
 *
 * @module workers/phases/phase-5-raw-decode
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";

import { isBlankImage } from "../../utils/blank-image-detector";
import { logger } from "../../utils/logger";

// ============================================================================
// Types
// ============================================================================

/**
 * RAW スクリーンショットのメタデータ
 *
 * RAW バッファ/ファイルからの crop に必要な情報を保持する。
 * RAW screenshot metadata required for crop operations.
 */
export interface RawScreenshotMetadata {
  /** RAW ファイルのパス / Path to the RAW file */
  rawPath: string;
  /** 画像の幅 / Image width in pixels */
  width: number;
  /** 画像の高さ / Image height in pixels */
  height: number;
  /** チャンネル数（通常4: RGBA） / Number of channels (typically 4: RGBA) */
  channels: number;
}

/**
 * RAW ベースの crop パラメータ
 *
 * acquireSectionCropBufferFromRaw() に渡すパラメータ。
 * Parameters for acquireSectionCropBufferFromRaw().
 */
export interface RawCropParams {
  /** RAW スクリーンショットのメタデータ / RAW screenshot metadata */
  rawMeta: RawScreenshotMetadata;
  /** セクションの位置情報 / Section position info */
  sectionPos: { startY: number; height: number };
  /** 画像の幅 / Image width */
  imgWidth: number;
  /** 画像の高さ / Image height */
  imgHeight: number;
  /** DINOv2 入力サイズ / DINOv2 input size */
  dinov2InputSize: number;
  /**
   * 事前ロード済み RAW バッファ（オプション）/ Pre-loaded RAW buffer (optional)
   *
   * 指定された場合、ファイル読み込みをスキップしこのバッファを直接使用する。
   * ループ内で同一バッファを再利用することでファイル I/O を削減する。
   * When provided, skips file read and uses this buffer directly.
   * Reuse the same buffer in a loop to eliminate file I/O.
   */
  rawBuffer?: Buffer;
}

/**
 * RAW ベースの crop 結果
 *
 * acquireSectionCropBufferFromRaw() の戻り値。
 * Return value of acquireSectionCropBufferFromRaw().
 */
export interface RawCropResult {
  /** DINOv2 用 raw crop バッファ（null の場合はスキップ） / DINOv2 raw crop buffer (null = skip) */
  rawCropBuffer: Buffer | null;
  /** 白画像として検出されたか / Whether detected as blank image */
  isBlank: boolean;
}

// ============================================================================
// Temp Directory Management (TMP-1, TMP-2)
// ============================================================================

/**
 * Phase 5 用のジョブ固有一時ディレクトリを作成する (TMP-1)
 *
 * Creates a job-specific temp directory for Phase 5 (TMP-1).
 * Directory permissions are 0o700 (owner rwx only).
 * Path is constructed from internal prefix only (TMP-4: no user input).
 *
 * @returns 作成されたディレクトリパス / Created directory path
 */
export function createPhase5TempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reftrix-phase5-"));
  // mkdtempSync uses process umask; explicitly set to 0o700 for security
  fs.chmodSync(dir, 0o700);
  return dir;
}

/**
 * Phase 5 用の一時ディレクトリを削除する (TMP-2)
 *
 * Removes the Phase 5 temp directory and all its contents (TMP-2).
 * Designed to be called in a finally block for guaranteed cleanup.
 * Silently ignores errors (e.g., directory already removed).
 *
 * @param tmpDir - 削除対象のディレクトリパス / Directory path to remove
 */
export function cleanupPhase5TempDir(tmpDir: string): void {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (cleanupError) {
    // Best-effort cleanup: log but do not throw
    logger.warn("[Phase5RawDecode] Failed to cleanup temp directory (non-fatal)", {
      tmpDir,
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    });
  }
}

// ============================================================================
// PNG Save (Phase 0 → Phase 5 Bridge)
// ============================================================================

/**
 * screenshotBase64 を PNG ファイルとして保存する
 *
 * Phase 0 で取得した screenshotBase64 を一時ディレクトリに PNG ファイルとして保存。
 * Phase 5 で RAW デコードに使用する。ファイルパーミッションは 0o600 (TMP-3)。
 *
 * Saves screenshotBase64 as a PNG file in the temp directory.
 * Used by Phase 5 for RAW decode. File permissions set to 0o600 (TMP-3).
 *
 * @param tmpDir - 一時ディレクトリパス / Temp directory path
 * @param base64Data - Base64 エンコードされた PNG データ / Base64-encoded PNG data
 * @returns 保存された PNG ファイルのパス / Saved PNG file path
 * @throws Error if base64Data is empty
 */
export function saveScreenshotAsPng(tmpDir: string, base64Data: string): string {
  if (!base64Data || base64Data.length === 0) {
    throw new Error("[Phase5RawDecode] Cannot save empty base64 data as PNG");
  }

  const pngPath = path.join(tmpDir, "screenshot.png");
  const buffer = Buffer.from(base64Data, "base64");
  fs.writeFileSync(pngPath, buffer, { mode: 0o600 }); // TMP-3
  return pngPath;
}

// ============================================================================
// RAW Decode (Single-Pass)
// ============================================================================

/**
 * PNG ファイルを1回だけ RAW デコードし RAW ファイルに保存する
 *
 * PNG ファイルを sharp() で1回だけ RGBA RAW バッファにデコードし、
 * そのバッファをファイルに書き出す。以降の crop 処理はこの RAW バッファ
 * （または RAW ファイルから再読み込み）を使い、PNG デコードが不要になる。
 *
 * Decodes a PNG file to RGBA RAW buffer once via sharp(), then writes the
 * buffer to a file. Subsequent crop operations use this RAW buffer
 * (or reload from the RAW file) with zero PNG decode cost.
 *
 * @param pngPath - PNG ファイルのパス / PNG file path
 * @param tmpDir - RAW ファイルの保存先ディレクトリ / Directory to save RAW file
 * @returns RAW メタデータ（null の場合はデコード失敗） / RAW metadata (null on failure)
 */
export async function decodeToRawFile(
  pngPath: string,
  tmpDir: string
): Promise<RawScreenshotMetadata | null> {
  try {
    // P0-B: Path Traversal defense — ensure pngPath is within tmpDir
    const resolvedPng = path.resolve(pngPath);
    const resolvedTmp = path.resolve(tmpDir);
    if (!resolvedPng.startsWith(resolvedTmp)) {
      logger.warn("[Phase5RawDecode] Path traversal detected, skipping RAW decode");
      return null;
    }

    if (!fs.existsSync(pngPath)) {
      logger.warn("[Phase5RawDecode] PNG file not found, skipping RAW decode", { pngPath });
      return null;
    }

    // P0-B: File size limit (500MB)
    const MAX_PNG_SIZE_BYTES = 500 * 1024 * 1024;
    const pngStat = fs.statSync(pngPath);
    if (pngStat.size > MAX_PNG_SIZE_BYTES) {
      logger.warn("[Phase5RawDecode] PNG file exceeds 500MB limit, skipping RAW decode", {
        sizeMb: Math.round(pngStat.size / 1024 / 1024),
      });
      return null;
    }

    // 1回だけ PNG → RGBA RAW デコード
    const meta = await sharp(pngPath).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;

    if (width <= 0 || height <= 0) {
      logger.warn("[Phase5RawDecode] Invalid image dimensions", { width, height });
      return null;
    }

    const channels = 4; // Always RGBA for consistent extract()
    const rawBuffer = await sharp(pngPath).ensureAlpha().raw().toBuffer();

    // RAW ファイルに書き出し (TMP-3: mode 0o600)
    const rawPath = path.join(tmpDir, "screenshot.raw");
    fs.writeFileSync(rawPath, rawBuffer, { mode: 0o600 });

    return { rawPath, width, height, channels };
  } catch (decodeError) {
    logger.warn("[Phase5RawDecode] RAW decode failed (Graceful Degradation)", {
      pngPath,
      error: decodeError instanceof Error ? decodeError.message : String(decodeError),
    });
    return null;
  }
}

/**
 * RAW ファイルからバッファを読み込む
 *
 * Phase 5 のセクション/パーツ visual embedding ループの開始時に1回呼び出し、
 * ループ内では rawBuffer パラメータとして acquireSectionCropBufferFromRaw に渡す。
 * ループ終了後にバッファ参照を null にしてメモリ解放する。
 *
 * Called once at the start of the section/part visual embedding loop in Phase 5.
 * The returned buffer is passed as the rawBuffer parameter to acquireSectionCropBufferFromRaw
 * within the loop. Set the buffer reference to null after the loop for memory release.
 *
 * @param rawMeta - RAW メタデータ / RAW metadata
 * @returns RAW バッファ（null の場合は読み込み失敗） / RAW buffer (null on failure)
 */
export function loadRawBuffer(rawMeta: RawScreenshotMetadata): Buffer | null {
  try {
    return fs.readFileSync(rawMeta.rawPath);
  } catch (readError) {
    logger.warn("[Phase5RawDecode] Failed to load RAW buffer from file", {
      rawPath: rawMeta.rawPath,
      error: readError instanceof Error ? readError.message : String(readError),
    });
    return null;
  }
}

// ============================================================================
// RAW-Based Section Crop
// ============================================================================

/**
 * RAW バッファからセクションを crop し DINOv2 用バッファを生成する
 *
 * RAW バッファ（既にデコード済み）から sharp(buffer, {raw:...}).extract() で
 * 直接 crop する。PNG デコードが不要なため、セクション数に比例した
 * メモリ消費（230MB/回）を回避できる。
 *
 * rawBuffer パラメータが指定された場合はそれを使用し、未指定の場合は
 * RAW ファイルから読み込む（Graceful Degradation）。
 *
 * isBlankImage 互換性 (TPA-2): crop 後に一旦 PNG エンコードしてから
 * isBlankImage() に渡すことで、従来の PNG ベース判定と同一結果を保証する。
 *
 * Crops a section from the pre-decoded RAW buffer and generates a DINOv2-ready buffer.
 * Uses sharp(rawBuffer, {raw:...}).extract() for direct crop without PNG decode,
 * avoiding ~230MB/section memory consumption.
 *
 * Uses the provided rawBuffer if available, otherwise falls back to reading
 * from the RAW file (Graceful Degradation).
 *
 * isBlankImage compatibility (TPA-2): encodes cropped region to PNG before
 * passing to isBlankImage() to guarantee identical results with PNG-based path.
 *
 * @param params - crop パラメータ / Crop parameters
 * @returns crop 結果 / Crop result
 */
export async function acquireSectionCropBufferFromRaw(
  params: RawCropParams
): Promise<RawCropResult> {
  const { rawMeta, sectionPos, imgWidth, imgHeight, dinov2InputSize, rawBuffer } = params;

  const sectionTop = Math.max(0, Math.round(sectionPos.startY));
  const sectionCropWidth = Math.max(1, imgWidth);
  const sectionCropHeight = Math.min(
    Math.round(sectionPos.height),
    Math.max(1, imgHeight - sectionTop)
  );

  if (sectionCropWidth <= 0 || sectionCropHeight <= 0) {
    return { rawCropBuffer: null, isBlank: false };
  }

  // Out of range: defer to fallback path
  if (sectionTop >= imgHeight) {
    return { rawCropBuffer: null, isBlank: false };
  }

  const sectionLeft = 0;

  // RAW バッファから直接 crop（PNG デコード不要）
  // rawBuffer が指定されていればそれを使用、なければファイルから読み込み
  const effectiveRawBuffer = rawBuffer ?? fs.readFileSync(rawMeta.rawPath);

  // TPA-2: isBlankImage 互換性のため、crop → PNG エンコードして判定
  const croppedPngBuffer = await sharp(effectiveRawBuffer, {
    raw: {
      width: rawMeta.width,
      height: rawMeta.height,
      channels: rawMeta.channels as 1 | 2 | 3 | 4,
    },
  })
    .extract({
      left: sectionLeft,
      top: sectionTop,
      width: sectionCropWidth,
      height: sectionCropHeight,
    })
    .png()
    .toBuffer();

  const blank = await isBlankImage(croppedPngBuffer);
  if (blank) {
    return { rawCropBuffer: null, isBlank: true };
  }

  // DINOv2 用: resize → removeAlpha → srgb → raw
  const rawCropBuffer = await sharp(croppedPngBuffer)
    .resize(dinov2InputSize, dinov2InputSize, { fit: "cover", kernel: "cubic" })
    .removeAlpha()
    .toColorspace("srgb")
    .raw()
    .toBuffer();

  return { rawCropBuffer, isBlank: false };
}
