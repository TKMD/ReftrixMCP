// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Visual Regression Service
 *
 * Pixelmatch によるピクセルレベル diff + Sharp による diff image 生成。
 * design_snapshots テーブルをベースラインストアとして活用し、
 * 閾値ベースの pass/fail 判定を行う。
 *
 * Visual Regression Service
 * Pixel-level diff via Pixelmatch + diff image generation via Sharp.
 * Uses design_snapshots table as baseline store with threshold-based pass/fail.
 *
 * @module services/visual-regression.service
 */

import path from "node:path";
import fs from "node:fs/promises";
import pixelmatch from "pixelmatch";
import sharp from "sharp";
import { logger } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import { createDIFactory } from "../utils/di-factory";
import { validateExternalUrl } from "../utils/url-validator";

// =====================================================
// Constants / 定数
// =====================================================

/** デフォルトの回帰テスト閾値（0.1% = 0.001） / Default regression threshold (0.1%) */
const DEFAULT_REGRESSION_THRESHOLD = 0.001;

/** Pixelmatch の色差しきい値（0-1、低いほど厳密） / Pixelmatch color threshold */
const PIXELMATCH_THRESHOLD = 0.1;

/** 最大画像サイズ (bytes) — 50MB / Max image size */
const MAX_IMAGE_SIZE = 50 * 1024 * 1024;

// =====================================================
// Error Codes / エラーコード
// =====================================================

export const VISUAL_REGRESSION_ERROR_CODES = {
  VALIDATION_ERROR: "VISUAL_REGRESSION_VALIDATION_ERROR",
  BASELINE_NOT_FOUND: "VISUAL_REGRESSION_BASELINE_NOT_FOUND",
  CAPTURE_FAILED: "VISUAL_REGRESSION_CAPTURE_FAILED",
  DIFF_FAILED: "VISUAL_REGRESSION_DIFF_FAILED",
  SNAPSHOT_NOT_FOUND: "VISUAL_REGRESSION_SNAPSHOT_NOT_FOUND",
  DIMENSION_MISMATCH: "VISUAL_REGRESSION_DIMENSION_MISMATCH",
} as const;

// =====================================================
// Types / 型定義
// =====================================================

export interface VisualRegressionInput {
  /** ベースラインスナップショットID / Baseline snapshot ID */
  baselineSnapshotId: string;
  /** 比較対象URL / URL to compare against baseline */
  url: string;
  /** pass/fail 閾値（0-1、デフォルト 0.001 = 0.1%） / Threshold (0-1) */
  threshold?: number;
  /** ビューポート幅 / Viewport width */
  viewportWidth?: number;
  /** ビューポート高さ / Viewport height */
  viewportHeight?: number;
}

export interface VisualRegressionResult {
  success: boolean;
  /** pass/fail 判定 / Test result */
  passed?: boolean;
  /** 変更ピクセル割合（0-1） / Change percentage (0-1) */
  changePercentage?: number;
  /** 変更ピクセル数 / Changed pixel count */
  changedPixels?: number;
  /** 全ピクセル数 / Total pixel count */
  totalPixels?: number;
  /** 使用閾値 / Threshold used */
  threshold?: number;
  /** diff画像（Base64 PNG） / Diff image (Base64 PNG) */
  diffImageBase64?: string;
  /** ベースライン情報 / Baseline info */
  baseline?: {
    snapshotId: string;
    snapshotAt: string;
    webPageUrl: string;
  };
  /** エラー情報 / Error info */
  error?: string;
}

interface BaselineMetadata {
  screenshot_full_url?: string;
  analysis_version?: string | null;
}

interface BaselineRow {
  id: string;
  webPageId: string;
  snapshotAt: Date;
  metadata: BaselineMetadata | null;
  webPage: { url: string };
}

// =====================================================
// DI Factory / 依存性注入ファクトリ
// =====================================================

export interface IVisualRegressionPrismaClient {
  designSnapshot: {
    findUnique: (args: {
      where: { id: string };
      include?: { webPage?: { select?: { url?: boolean } } };
    }) => Promise<{
      id: string;
      webPageId: string;
      snapshotAt: Date;
      metadata: unknown;
      webPage?: { url: string };
    } | null>;
  };
}

const visualRegressionPrismaDI = createDIFactory<IVisualRegressionPrismaClient>(
  "VisualRegressionPrismaClient"
);

export const getVisualRegressionPrismaClientFactory = visualRegressionPrismaDI.get;
export const setVisualRegressionPrismaClientFactory = visualRegressionPrismaDI.set;
export const resetVisualRegressionPrismaClientFactory = visualRegressionPrismaDI.reset;

// =====================================================
// Screenshot Capture / スクリーンショットキャプチャ
// =====================================================

/**
 * Playwright でURLのフルページスクリーンショットをキャプチャ
 * Capture full-page screenshot of URL via Playwright
 */
async function captureScreenshot(
  url: string,
  viewportWidth: number,
  viewportHeight: number
): Promise<Buffer> {
  // Defense-in-depth: SSRF prevention at service layer
  const urlValidation = validateExternalUrl(url);
  if (!urlValidation.valid) {
    throw new Error("URL blocked by security policy");
  }

  // Dynamic import to avoid loading Playwright at module level
  const { chromium } = await import("playwright");

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: viewportWidth, height: viewportHeight },
    });
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    const screenshot = await page.screenshot({ fullPage: true, type: "png" });
    return Buffer.from(screenshot);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// =====================================================
// Core Logic / コアロジック
// =====================================================

/**
 * ベースラインスナップショットの metadata.screenshot_full_url からスクリーンショットを取得
 * Retrieve baseline screenshot from snapshot's metadata.screenshot_full_url (Option B)
 */
async function getBaselineScreenshot(snapshotId: string): Promise<{
  buffer: Buffer;
  snapshot: BaselineRow;
} | null> {
  const factory = getVisualRegressionPrismaClientFactory();
  if (!factory) return null;

  const prisma = factory();

  // Prisma client で metadata を含めて取得（raw SQL 廃止）
  const row = await prisma.designSnapshot.findUnique({
    where: { id: snapshotId },
    include: { webPage: { select: { url: true } } },
  });

  if (!row) return null;

  const snapshot: BaselineRow = {
    id: row.id,
    webPageId: row.webPageId,
    snapshotAt: row.snapshotAt,
    metadata: row.metadata as BaselineMetadata | null,
    webPage: row.webPage ?? { url: "" },
  };

  // Option B: metadata から snapshot 時点の screenshot_full_url を取得
  const metadata = snapshot.metadata;
  const baselineUrl = metadata?.screenshot_full_url;
  if (!baselineUrl) {
    logger.warn("Snapshot lacks metadata.screenshot_full_url (old snapshot or missing)", {
      snapshotId: snapshot.id,
    });
    return null;
  }

  // Base64 data URI の場合
  if (baselineUrl.startsWith("data:image/")) {
    const base64Data = baselineUrl.replace(/^data:image\/\w+;base64,/, "");
    return { buffer: Buffer.from(base64Data, "base64"), snapshot };
  }

  // ファイルパスの場合 — path.resolve + realpath + allowlist 検証
  const ALLOWED_SCREENSHOT_ROOT_RAW = path.resolve(
    process.env.REFTRIX_SCREENSHOT_ROOT ?? "/tmp/reftrix-screenshots"
  );
  let ALLOWED_SCREENSHOT_ROOT: string;
  try {
    ALLOWED_SCREENSHOT_ROOT = await fs.realpath(ALLOWED_SCREENSHOT_ROOT_RAW);
  } catch {
    // ディレクトリ未作成時（初回起動など）は raw path を fallback として使用
    ALLOWED_SCREENSHOT_ROOT = ALLOWED_SCREENSHOT_ROOT_RAW;
  }
  try {
    // baselineUrl 側も realpath で symlink を解決（symlink follow 攻撃対策）
    const resolved = await fs.realpath(path.resolve(baselineUrl));
    if (
      !resolved.startsWith(ALLOWED_SCREENSHOT_ROOT + path.sep) &&
      resolved !== ALLOWED_SCREENSHOT_ROOT
    ) {
      logger.warn("Rejected out-of-root screenshot path", {
        snapshotId: snapshot.id,
        expected: ALLOWED_SCREENSHOT_ROOT,
      });
      return null;
    }
    const buffer = await fs.readFile(resolved);
    if (buffer.length > MAX_IMAGE_SIZE) return null;
    return { buffer, snapshot };
  } catch (err) {
    logger.warn("Failed to read baseline screenshot", {
      snapshotId: snapshot.id,
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * 2枚の画像をPixelmatchで比較し、diffを算出
 * Compare two images via Pixelmatch and calculate diff
 */
async function computeDiff(
  baselineBuffer: Buffer,
  currentBuffer: Buffer
): Promise<{
  changedPixels: number;
  totalPixels: number;
  changePercentage: number;
  diffImageBase64: string;
  width: number;
  height: number;
}> {
  // 画像のRGBAデータを取得
  const baselineMeta = await sharp(baselineBuffer).metadata();
  const currentMeta = await sharp(currentBuffer).metadata();

  if (!baselineMeta.width || !baselineMeta.height || !currentMeta.width || !currentMeta.height) {
    throw new Error("Cannot read image dimensions");
  }

  // 画像サイズを統一（大きい方に合わせる）
  const width = Math.max(baselineMeta.width, currentMeta.width);
  const height = Math.max(baselineMeta.height, currentMeta.height);

  const baselineRaw = await sharp(baselineBuffer)
    .resize(width, height, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .raw()
    .ensureAlpha()
    .toBuffer();

  const currentRaw = await sharp(currentBuffer)
    .resize(width, height, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .raw()
    .ensureAlpha()
    .toBuffer();

  // Diff画像バッファ
  const diffRaw = Buffer.alloc(width * height * 4);

  // Pixelmatch 実行
  const changedPixels = pixelmatch(
    new Uint8Array(baselineRaw),
    new Uint8Array(currentRaw),
    new Uint8Array(diffRaw),
    width,
    height,
    { threshold: PIXELMATCH_THRESHOLD, includeAA: false }
  );

  const totalPixels = width * height;
  const changePercentage = totalPixels > 0 ? changedPixels / totalPixels : 0;

  // Diff画像をPNG Base64に変換
  const diffPng = await sharp(diffRaw, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();

  const diffImageBase64 = diffPng.toString("base64");

  return { changedPixels, totalPixels, changePercentage, diffImageBase64, width, height };
}

// =====================================================
// Main Entry / メインエントリ
// =====================================================

/**
 * Visual Regression テスト実行
 * Execute visual regression test
 */
export async function runVisualRegression(
  input: VisualRegressionInput
): Promise<VisualRegressionResult> {
  const threshold = input.threshold ?? DEFAULT_REGRESSION_THRESHOLD;
  const viewportWidth = input.viewportWidth ?? 1920;
  const viewportHeight = input.viewportHeight ?? 1080;

  // 1. ベースラインスナップショット取得
  const baselineData = await getBaselineScreenshot(input.baselineSnapshotId);
  if (!baselineData) {
    return {
      success: false,
      error: `${VISUAL_REGRESSION_ERROR_CODES.BASELINE_NOT_FOUND}: Baseline snapshot not found or has no screenshot`,
    };
  }

  // 2. 現在のスクリーンショットをキャプチャ
  let currentBuffer: Buffer;
  try {
    currentBuffer = await captureScreenshot(input.url, viewportWidth, viewportHeight);
  } catch (error) {
    logger.warn("[VisualRegression] Screenshot capture failed", {
      url: input.url,
      error: sanitizeErrorMessage(error),
    });
    return {
      success: false,
      error: `${VISUAL_REGRESSION_ERROR_CODES.CAPTURE_FAILED}: ${sanitizeErrorMessage(error)}`,
    };
  }

  // 3. Diff計算
  let diffResult;
  try {
    diffResult = await computeDiff(baselineData.buffer, currentBuffer);
  } catch (error) {
    logger.warn("[VisualRegression] Diff computation failed", {
      error: sanitizeErrorMessage(error),
    });
    return {
      success: false,
      error: `${VISUAL_REGRESSION_ERROR_CODES.DIFF_FAILED}: ${sanitizeErrorMessage(error)}`,
    };
  }

  // 4. Pass/Fail 判定
  const passed = diffResult.changePercentage <= threshold;

  return {
    success: true,
    passed,
    changePercentage: Math.round(diffResult.changePercentage * 10000) / 10000, // 4桁精度
    changedPixels: diffResult.changedPixels,
    totalPixels: diffResult.totalPixels,
    threshold,
    diffImageBase64: diffResult.diffImageBase64,
    baseline: {
      snapshotId: baselineData.snapshot.id,
      snapshotAt: baselineData.snapshot.snapshotAt.toISOString(),
      webPageUrl: baselineData.snapshot.webPage.url,
    },
  };
}
