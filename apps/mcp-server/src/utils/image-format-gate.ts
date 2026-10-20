// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 画像入力の許可形式 gate（層 2）。sharp にも logger にも依存しない（log は呼出し側が出す）。
 * Image input format allowlist gate (layer 2). No sharp or logger dependency; callers log.
 *
 * 入口（design.search_by_image / layout.inspect の screenshot）で、decode の前に先頭 byte を
 * 見て PNG / JPEG / WebP 以外を拒否する。ラベル（content-type / MIME / 拡張子）は見ない。
 * At the entries, the leading bytes are checked before any decode and anything other than
 * PNG / JPEG / WebP is rejected. Labels (content-type / MIME / extension) are never trusted.
 *
 * @see ADR-0049 / INV-SEC-IMAGE-INPUT-GATE-001
 */

import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";

export type RasterFormat = "png" | "jpeg" | "webp";

/** design.search_by_image が受理する形式 / Formats accepted by design.search_by_image */
export const P1_RASTER_ALLOW: readonly RasterFormat[] = ["png", "jpeg", "webp"];
/** layout.inspect の screenshot.mimeType の宣言と同一 / Same as the declared screenshot.mimeType */
export const P2_RASTER_ALLOW: readonly RasterFormat[] = ["png", "jpeg", "webp"];
/** frame ファイルの拡張子 allowlist と同一 / Same as the frame file extension allowlist */
export const FRAME_RASTER_ALLOW: readonly RasterFormat[] = ["png", "jpeg"];

/**
 * 拒否時の固定文。入力の内容・検出形式・loader 名・path・URL を含めない。
 * Fixed rejection text. It never carries input content, the detected format, a loader name,
 * a path or a URL.
 */
export const UNSUPPORTED_IMAGE_FORMAT_MESSAGE =
  "Unsupported image format. Accepted formats are PNG, JPEG and WebP.";

/** 先頭 byte の判定に十分な長さ / Bytes needed to decide the format */
const HEAD_BYTES = 16;
/** P2 が先頭 HEAD_BYTES を得るまで decode する base64 文字数の上限 / Head-decode char limit */
export const SCREENSHOT_HEAD_DECODE_LIMIT_CHARS = 4096;

interface Signature {
  readonly format: RasterFormat;
  readonly parts: readonly { readonly offset: number; readonly bytes: readonly number[] }[];
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

const SIGNATURES: readonly Signature[] = [
  {
    format: "png",
    parts: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  },
  { format: "jpeg", parts: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }] },
  {
    format: "webp",
    parts: [
      { offset: 0, bytes: ascii("RIFF") },
      { offset: 8, bytes: ascii("WEBP") },
    ],
  },
];

/**
 * 先頭 byte から raster 形式を判定する。SVG / XML / gzip / BOM / 空白始まりは null。
 * Detects the raster format from the leading bytes; SVG / XML / gzip / BOM / whitespace-led
 * input yields null.
 */
export function detectRasterFormat(head: Uint8Array): RasterFormat | null {
  for (const sig of SIGNATURES) {
    const match = sig.parts.every(
      (p) =>
        head.length >= p.offset + p.bytes.length &&
        p.bytes.every((b, i) => head[p.offset + i] === b)
    );
    if (match) return sig.format;
  }
  return null;
}

export class UnsupportedImageFormatError extends Error {
  /** サーバーログ専用。message には含めない / Server log only; never put in the message */
  readonly detected: RasterFormat | "unknown";

  constructor(detected: RasterFormat | "unknown" = "unknown") {
    super(UNSUPPORTED_IMAGE_FORMAT_MESSAGE);
    this.name = "UnsupportedImageFormatError";
    this.detected = detected;
  }
}

/** allowlist 外なら UnsupportedImageFormatError / Throws when outside the allowlist. */
export function assertAllowedRaster(buf: Uint8Array, allow: readonly RasterFormat[]): void {
  const format = detectRasterFormat(buf.subarray(0, HEAD_BYTES));
  if (format === null || !allow.includes(format)) {
    throw new UnsupportedImageFormatError(format ?? "unknown");
  }
}

/**
 * base64 data URI の接頭辞を除去する。ラベル（svg+xml / 大文字など）は問わない。
 * 除去後の bytes を判定するので fail-closed は不変。
 * Strips a base64 data URI prefix whatever its label or case; the gate judges the bytes after
 * stripping, so fail-closed is unchanged.
 */
export function normalizeScreenshotBase64(s: string): string {
  return s.replace(/^data:[^,]*;base64,/i, "");
}

export interface NonRasterScreenshotRejection {
  readonly success: false;
  readonly error: { readonly code: "VALIDATION_ERROR"; readonly message: string };
}

/**
 * layout.inspect の screenshot 用。先頭 K 文字までを decode して判定し、不一致なら
 * VALIDATION_ERROR を返す。一致なら null。onReject はサーバーログ用の通知。
 * For the layout.inspect screenshot: decodes up to K characters, returns a VALIDATION_ERROR
 * when the head is not an allowed raster, null otherwise. onReject is for the server log.
 */
export function rejectNonRasterScreenshot(
  base64: string,
  onReject?: (info: { detected: RasterFormat | "unknown"; base64Length: number }) => void
): NonRasterScreenshotRejection | null {
  const head = Buffer.from(
    normalizeScreenshotBase64(base64).slice(0, SCREENSHOT_HEAD_DECODE_LIMIT_CHARS),
    "base64"
  ).subarray(0, HEAD_BYTES);
  const format = detectRasterFormat(head);
  if (format !== null && P2_RASTER_ALLOW.includes(format)) return null;
  onReject?.({ detected: format ?? "unknown", base64Length: base64.length });
  return {
    success: false,
    error: { code: "VALIDATION_ERROR", message: UNSUPPORTED_IMAGE_FORMAT_MESSAGE },
  };
}

// ---- P3: file snapshot (frame_dir / frame loader / video frames) ----

/** 最大 viewport。Zod の上限と INV で照合する / Max viewport, pinned to the Zod bounds by the INV */
export const FRAME_VIEWPORT_MAX = { width: 4096, height: 4096 } as const;
export const PNG_ROW_FILTER_BYTES = 1; // 行ごとの filter byte / per-row filter byte
export const PNG_DEFLATE_MARGIN_DIVISOR = 100; // 1%（実測の膨張 +0.33% を上回る）/ 1% margin
export const PNG_CONTAINER_OVERHEAD_BYTES = 4096; // signature / IHDR / chunk header / IEND

const isPositiveSafeInteger = (v: number): boolean => Number.isSafeInteger(v) && v > 0;

/** 上限 = W*H*C + H + 1% + 4096。不正な入力は throw し、上限なしには倒れない / invalid input throws */
export function deriveRasterSnapshotMaxBytes(
  width: number,
  height: number,
  bytesPerPixel: number
): number {
  for (const v of [width, height, bytesPerPixel]) {
    if (!isPositiveSafeInteger(v)) throw new TypeError("invalid dimension");
  }
  const filtered = width * height * bytesPerPixel + height * PNG_ROW_FILTER_BYTES;
  const result =
    filtered + Math.ceil(filtered / PNG_DEFLATE_MARGIN_DIVISOR) + PNG_CONTAINER_OVERHEAD_BYTES;
  if (!Number.isSafeInteger(result)) throw new TypeError("invalid cap");
  return result;
}

export const VIDEO_FRAME_BYTES_PER_PIXEL = 3; // ffmpeg を -pix_fmt rgb24 に固定 / ffmpeg pinned to rgb24
export const FRAME_CAPTURE_BYTES_PER_PIXEL = 4; // Playwright screenshot は RGBA 前提 / assumed RGBA
const { width: VW, height: VH } = FRAME_VIEWPORT_MAX;
export const VIDEO_FRAME_SNAPSHOT_MAX_BYTES = deriveRasterSnapshotMaxBytes(
  VW,
  VH,
  VIDEO_FRAME_BYTES_PER_PIXEL
);
export const FRAME_CAPTURE_SNAPSHOT_MAX_BYTES = deriveRasterSnapshotMaxBytes(
  VW,
  VH,
  FRAME_CAPTURE_BYTES_PER_PIXEL
);

export const FRAME_SNAPSHOT_REASONS = [
  "unsupported_image_format",
  "file_too_large",
  "not_a_regular_file",
  "open_failed",
] as const;
export type FrameSnapshotReason = (typeof FRAME_SNAPSHOT_REASONS)[number];

/** 固定文。path・errno の文面を含めない / Fixed text; no path or errno text */
const SNAPSHOT_MESSAGES: Readonly<Record<FrameSnapshotReason, string>> = {
  unsupported_image_format: UNSUPPORTED_IMAGE_FORMAT_MESSAGE,
  file_too_large: "Frame file exceeds the size limit.",
  not_a_regular_file: "Frame path is not a regular file.",
  open_failed: "Frame file could not be read.",
};
const FS_CODES = ["ENOENT", "EACCES", "EPERM", "ELOOP", "ENXIO", "EMFILE", "ENFILE"] as const;
export type FrameSnapshotFsCode = (typeof FS_CODES)[number] | "OTHER";

export class FrameSnapshotError extends Error {
  /** @param fsCode 元の errno（enum）。message には出さない / original errno as an enum, never in the message */
  constructor(
    readonly reason: FrameSnapshotReason,
    readonly fsCode?: FrameSnapshotFsCode
  ) {
    super(SNAPSHOT_MESSAGES[reason]);
    this.name = "FrameSnapshotError";
  }
}

/** fs の失敗を open_failed に正規化する / Normalises a fs failure to open_failed */
const fsStep = <T>(op: Promise<T>): Promise<T> =>
  op.catch((e: unknown) => {
    const code = (e as { code?: unknown } | null)?.code;
    throw new FrameSnapshotError("open_failed", FS_CODES.find((c) => c === code) ?? "OTHER");
  });

/** 同じ fd から EOF まで読む。増えた file は拒否 / Reads to EOF from the same fd; a grown file is refused */
async function readToEof(fh: FileHandle, size: number): Promise<Buffer> {
  const buf = Buffer.alloc(size + 1);
  let total = 0;
  for (;;) {
    const { bytesRead } = await fsStep(fh.read(buf, total, buf.length - total, total));
    if (bytesRead === 0) return buf.subarray(0, total);
    total += bytesRead;
    if (total > size) throw new FrameSnapshotError("file_too_large");
  }
}

/**
 * path を一度だけ開き、同じ fd で fstat と EOF までの読込みを行い、その buffer を判定して返す
 * （判定と decode が同じ bytes。path は開き直さない）。
 * Opens once, fstat()s and reads to EOF from the same fd, gates and returns that buffer: the gate
 * and the decode see the same bytes (no TOCTOU window); the path is never reopened.
 */
export async function readRasterFileSnapshot(
  filePath: string,
  allow: readonly RasterFormat[],
  maxBytes: number
): Promise<Buffer> {
  if (!isPositiveSafeInteger(maxBytes)) throw new TypeError("invalid maxBytes");
  const { O_RDONLY, O_NONBLOCK, O_NOCTTY } = fs.constants;
  if (typeof O_NONBLOCK !== "number" || typeof O_NOCTTY !== "number") {
    throw new TypeError("unsupported platform flags"); // 0 に黙って退化させない
  }
  // O_NONBLOCK + isFile(): FIFO / device への symlink で open が止まらない
  const fh: FileHandle = await fsStep(fs.promises.open(filePath, O_RDONLY | O_NONBLOCK | O_NOCTTY));
  try {
    const st = await fsStep(fh.stat());
    if (!st.isFile()) throw new FrameSnapshotError("not_a_regular_file");
    if (st.size > maxBytes) throw new FrameSnapshotError("file_too_large");
    const snapshot = await readToEof(fh, st.size);
    try {
      assertAllowedRaster(snapshot, allow);
    } catch (e) {
      throw e instanceof UnsupportedImageFormatError
        ? new FrameSnapshotError("unsupported_image_format")
        : e;
    }
    return snapshot;
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** log 用の reason。FrameSnapshotError 以外は analysis_error / Log reason; non-snapshot errors are analysis_error */
export function describeSnapshotFailure(error: unknown): FrameSnapshotReason | "analysis_error" {
  return error instanceof FrameSnapshotError ? error.reason : "analysis_error";
}
