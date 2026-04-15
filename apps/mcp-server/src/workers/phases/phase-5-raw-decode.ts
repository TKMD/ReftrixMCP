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
 * v0.4.0 変更 / v0.4.0 change:
 *   Screenshot PNG 自体の永続化は ScreenshotPersistenceService が担当する。
 *   本モジュールは RAW decode 用の **短命な** 一時ディレクトリのみを管理する。
 *   Screenshot PNG persistence is now owned by ScreenshotPersistenceService.
 *   This module only manages the **ephemeral** temp directory for RAW decode.
 *
 * TMP-1: fs.mkdtempSync(path.join(os.tmpdir(), 'reftrix-phase5-raw-')) でジョブ固有ディレクトリ
 * TMP-2: finally ブロックで fs.rmSync(tmpDir, {recursive: true, force: true}) 確実実行
 * TMP-3: ファイル作成時 mode: 0o600
 * TMP-4: パスはユーザー入力から構成しない（内部生成のみ）
 *
 * @module workers/phases/phase-5-raw-decode
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";

import { isBlankImage } from "../../utils/blank-image-detector";
import { logger } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";

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
 * Phase 5 RAW decode 用のジョブ固有一時ディレクトリを作成する (TMP-1)
 *
 * v0.4.0: `reftrix-phase5-raw-` プレフィックス（旧 `reftrix-phase5-` は
 * ScreenshotPersistenceService 配下の永続パスと衝突するため改名）。
 *
 * Creates a job-specific temp directory for Phase 5 RAW decode (TMP-1).
 * v0.4.0: renamed from `reftrix-phase5-` to `reftrix-phase5-raw-` to avoid
 * collision with the persisted screenshot path under ScreenshotPersistenceService.
 *
 * Directory permissions are 0o700 (owner rwx only).
 * Path is constructed from internal prefix only (TMP-4: no user input).
 *
 * @returns 作成されたディレクトリパス / Created directory path
 */
export function createPhase5TempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reftrix-phase5-raw-"));
  // mkdtempSync uses process umask; explicitly set to 0o700 for security
  fs.chmodSync(dir, 0o700);
  return dir;
}

/**
 * Phase 5 RAW decode 用のジョブ固有一時ディレクトリを削除する (TMP-2)
 *
 * Removes the Phase 5 **RAW-decode** temp directory (TMP-2).
 * Designed to be called in a finally block for guaranteed cleanup.
 * Silently ignores errors (e.g., directory already removed) — never throws.
 *
 * v0.4.0 PR7d-1 (SEC A-1): 3 段 whitelist 防御
 * v0.4.0 PR7d-1 (SEC A-1): 3-stage whitelist defense to prevent the
 * persisted screenshot directory (`<REFTRIX_SCREENSHOT_ROOT>/phase5/`)
 * from being accidentally deleted — which was the PR7b/PR7c carry-over
 * bug that broke Queue-based Backfill visual embeddings:
 *   1. Input normalization + null-byte rejection
 *   2. realpath() resolution (defeats symlink attacks; silent return on ENOENT)
 *   3. Whitelist verification — must be under os.tmpdir() AND basename must
 *      start with `reftrix-phase5-raw-`
 *
 * **永続化パス `<REFTRIX_SCREENSHOT_ROOT>/phase5/` は絶対に渡さないこと。**
 * **Never pass the persisted screenshot path (`<REFTRIX_SCREENSHOT_ROOT>/phase5/`).**
 * Persisted-screenshot deletion is consolidated into exactly two paths:
 *   (a) PR6 TTL cron (`scheduleScreenshotCleanupCron()`, 7d)
 *   (b) GDPR `data.delete` (Art. 17 synchronous, via
 *       `ScreenshotPersistenceService.deleteScreenshot()`)
 * See ADR-0010 and `DATA_RETENTION.md` §9 for the full deletion-path matrix.
 *
 * Note on the fork orchestrator helper:
 *   `cleanupPhase5TmpDirOnly()` in `phase-5-fork-orchestrator.ts` used to
 *   duplicate a subset of this whitelist. After PR7d-1 it delegates directly
 *   to this function (see A-3 in PR7d-1). A future refactor may rename this
 *   to `cleanupPhase5RawDecodeTmpDir` for clarity.
 *
 * @param tmpDir - 削除対象のディレクトリパス / Directory path to remove
 */
export function cleanupPhase5TempDir(tmpDir: string): void {
  // Stage 1: input normalization + null-byte defense.
  if (typeof tmpDir !== "string" || tmpDir.length === 0 || tmpDir.includes("\0")) {
    logger.warn("[Phase5RawDecode] cleanupPhase5TempDir rejected invalid input (non-fatal)");
    return;
  }

  // Stage 2: realpath resolution. Defeats symlink attacks and silently
  // returns on ENOENT (path already cleaned up by a previous call).
  let realTmp: string;
  let realOsTmp: string;
  try {
    realTmp = fs.realpathSync(tmpDir);
  } catch {
    // ENOENT / EACCES / ELOOP — treat as no-op.
    return;
  }
  try {
    realOsTmp = fs.realpathSync(os.tmpdir());
  } catch {
    // If we cannot resolve os.tmpdir(), we cannot enforce the whitelist —
    // fail closed (do nothing).
    return;
  }

  // Stage 3: whitelist — must be under os.tmpdir() AND have the expected prefix.
  const underOsTmp = realTmp.startsWith(realOsTmp + path.sep);
  const hasPrefix = path.basename(realTmp).startsWith("reftrix-phase5-raw-");
  if (!underOsTmp || !hasPrefix) {
    // Truncate the logged path to 80 chars for PII safety / log hygiene.
    const truncated = realTmp.slice(0, 80);
    logger.warn(
      "[Phase5RawDecode] cleanupPhase5TempDir rejected path outside whitelist (non-fatal)",
      { pathPrefix: truncated, underOsTmp, hasPrefix }
    );
    return;
  }

  try {
    fs.rmSync(realTmp, { recursive: true, force: true });
  } catch (cleanupError) {
    // Best-effort cleanup: log but do not throw.
    logger.warn("[Phase5RawDecode] Failed to cleanup temp directory (non-fatal)", {
      pathPrefix: realTmp.slice(0, 80),
      error: sanitizeErrorMessage(cleanupError),
    });
  }
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
    // P0-B: Path Traversal defense.
    //
    // v0.4.0 PR7d-2 (TDA LOW-1): The original guard required `pngPath` to sit
    // inside `tmpDir`. That assumption is no longer valid because RAW output
    // is now written to an ephemeral `reftrix-phase5-raw-*` dir distinct from
    // the persisted screenshot dir. Callers MUST pre-validate `pngPath`
    // (e.g. `isAllowedScreenshotPath()`). Here we instead require `tmpDir` to
    // be an ephemeral Phase 5 RAW dir under `os.tmpdir()` with the known
    // `reftrix-phase5-raw-` prefix — same whitelist shape enforced by
    // `cleanupPhase5TempDir()`. This prevents RAW writes into unexpected
    // locations even if a caller mis-constructs the destination dir.
    //
    // v0.4.0 PR7d-2 (TDA LOW-1): 従来ガード (pngPath が tmpDir 配下である必要)
    // は RAW 出力先を短命 `reftrix-phase5-raw-*` に分離した結果不成立。
    // 代わりに `tmpDir` が os.tmpdir() 配下の `reftrix-phase5-raw-` 接頭辞を
    // 持つディレクトリであることを要求する (`cleanupPhase5TempDir` と同一
    // whitelist 形状)。pngPath 自体の検証は呼び出し側の責務
    // (`isAllowedScreenshotPath` 等で事前検証すること)。
    const resolvedTmp = path.resolve(tmpDir);
    const resolvedOsTmp = path.resolve(os.tmpdir());
    const underOsTmp = resolvedTmp.startsWith(resolvedOsTmp + path.sep);
    const hasPrefix = path.basename(resolvedTmp).startsWith("reftrix-phase5-raw-");
    if (!underOsTmp || !hasPrefix) {
      logger.warn("[Phase5RawDecode] tmpDir outside ephemeral whitelist, skipping RAW decode");
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
