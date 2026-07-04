// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Report Template Service
 *
 * Handlebars テンプレートエンジンを使用して分析レポートを生成する。
 * HTML レポート（インタラクティブ）と PDF レポート（Playwright page.pdf()）の2形式。
 *
 * Report Template Service
 * Generates analysis reports using Handlebars template engine.
 * Supports HTML (interactive) and PDF (via Playwright page.pdf()) formats.
 *
 * v0.4.0 リファクタリング (TDA監査指摘対応):
 * - HTMLテンプレート外部化: templates/report.html.hbs
 * - aggregateReportData 分割: fetchWebPage, fetchSections, fetchMotions, fetchQuality
 * - スクリーンショット読み込み分離: readScreenshotAsBase64
 * - PDF生成 DI化: IPdfGenerator インターフェース
 *
 * @module services/report-template.service
 */

import fs from "fs/promises";
import path from "path";
import Handlebars from "handlebars";
import { logger } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import { createDIFactory } from "../utils/di-factory";
// PR-SS-A D-2 (UB-1): screenshot root default は SSOT (screenshot-persistence.service)
// から derive する (bare literal 重複定義禁止 — SSOT sweep test が CI 検出)。
// PR-SS-A D-2 (UB-1): derive the screenshot root default from the SSOT
// (no duplicated bare literals — CI-detected by the SSOT sweep test).
import { resolveScreenshotRootRaw } from "./screenshot-persistence.service";

// =====================================================
// Error Codes / エラーコード
// =====================================================

export const REPORT_ERROR_CODES = {
  VALIDATION_ERROR: "REPORT_VALIDATION_ERROR",
  PAGE_NOT_FOUND: "REPORT_PAGE_NOT_FOUND",
  NO_ANALYSIS_DATA: "REPORT_NO_ANALYSIS_DATA",
  TEMPLATE_ERROR: "REPORT_TEMPLATE_ERROR",
  PDF_CONVERSION_FAILED: "REPORT_PDF_CONVERSION_FAILED",
} as const;

// =====================================================
// Types / 型定義
// =====================================================

export interface ReportSection {
  type: string;
  name: string | null;
  positionIndex: number;
  heading: string | null;
  componentCount: number;
  layoutType: string | null;
}

export interface ReportMotionPattern {
  type: string;
  name: string | null;
  category: string;
  trigger: string;
  duration: number | null;
  easing: string | null;
}

export interface ReportQuality {
  overallScore: number;
  grade: string;
  antiAiCliche: number | null;
  designQuality: number | null;
  technicalQuality: number | null;
}

export interface ReportData {
  webPage: {
    id: string;
    url: string;
    title: string | null;
    analyzedAt: string | null;
    screenshotBase64: string | null;
  };
  sections: ReportSection[];
  motionPatterns: ReportMotionPattern[];
  quality: ReportQuality | null;
  generatedAt: string;
}

export interface ReportGenerateInput {
  webPageId: string;
  format: "html" | "pdf";
  title?: string;
  includeScreenshot?: boolean;
  includeMotion?: boolean;
  includeQuality?: boolean;
}

export interface ReportGenerateResult {
  success: boolean;
  format?: string;
  /** HTML content or PDF base64 */
  content?: string;
  /** Content size in bytes */
  contentSizeBytes?: number;
  error?: string;
}

// =====================================================
// DI Factory / 依存性注入ファクトリ
// =====================================================

export interface IReportPrismaClient {
  $queryRawUnsafe: (query: string, ...values: unknown[]) => Promise<unknown>;
}

/** PDF生成インターフェース（Playwright抽象化） */
export interface IPdfGenerator {
  generatePdf(htmlContent: string): Promise<Buffer>;
}

const reportPrismaDI = createDIFactory<IReportPrismaClient>("ReportPrismaClient");

export const getReportPrismaClientFactory = reportPrismaDI.get;
export const setReportPrismaClientFactory = reportPrismaDI.set;
export const resetReportPrismaClientFactory = reportPrismaDI.reset;

const pdfGeneratorDI = createDIFactory<IPdfGenerator>("PdfGenerator");

export const getPdfGeneratorFactory = pdfGeneratorDI.get;
export const setPdfGeneratorFactory = pdfGeneratorDI.set;
export const resetPdfGeneratorFactory = pdfGeneratorDI.reset;

// =====================================================
// Handlebars Helpers / テンプレートヘルパー
// =====================================================

Handlebars.registerHelper("scoreColor", function (score: number): string {
  if (score >= 80) return "#22c55e"; // green
  if (score >= 60) return "#eab308"; // yellow
  if (score >= 40) return "#f97316"; // orange
  return "#ef4444"; // red
});

Handlebars.registerHelper("truncate", function (str: string | null, len: number): string {
  if (!str) return "";
  return str.length > len ? str.substring(0, len) + "..." : str;
});

Handlebars.registerHelper("eq", function (a: unknown, b: unknown): boolean {
  return a === b;
});

Handlebars.registerHelper("add", function (a: number, b: number): number {
  return a + b;
});

Handlebars.registerHelper("round", function (value: number, decimals: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "N/A";
  return value.toFixed(typeof decimals === "number" ? decimals : 1);
});

// =====================================================
// Template Loading / テンプレート読み込み
// =====================================================

let cachedTemplate: HandlebarsTemplateDelegate | null = null;

function getHtmlTemplate(): HandlebarsTemplateDelegate {
  if (cachedTemplate) return cachedTemplate;

  const templatePath = path.join(__dirname, "../templates/report.html.hbs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const templateSource = require("fs").readFileSync(templatePath, "utf-8") as string;
  cachedTemplate = Handlebars.compile(templateSource);
  return cachedTemplate;
}

// =====================================================
// Data Fetchers / データ取得関数
// =====================================================

interface WebPageRow {
  id: string;
  url: string;
  title: string | null;
  analyzed_at: Date | null;
  screenshot_full_url: string | null;
}

async function fetchWebPage(
  prisma: IReportPrismaClient,
  webPageId: string
): Promise<WebPageRow | null> {
  const pages = (await prisma.$queryRawUnsafe(
    `SELECT id, url, title, analyzed_at, screenshot_full_url
     FROM web_pages WHERE id = $1::uuid LIMIT 1`,
    webPageId
  )) as WebPageRow[];

  return pages[0] ?? null;
}

async function fetchSections(
  prisma: IReportPrismaClient,
  webPageId: string
): Promise<ReportSection[]> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT section_type,
            section_name AS heading,
            position_index,
            jsonb_array_length(components) AS component_count,
            layout_info->>'type' as layout_type
     FROM section_patterns
     WHERE web_page_id = $1::uuid
     ORDER BY position_index ASC`,
    webPageId
  )) as Array<{
    section_type: string;
    heading: string | null;
    position_index: number;
    component_count: number;
    layout_type: string | null;
  }>;

  return rows.map((s) => ({
    type: s.section_type,
    name: s.heading,
    positionIndex: s.position_index,
    heading: s.heading,
    componentCount: s.component_count ?? 0,
    layoutType: s.layout_type,
  }));
}

async function fetchMotions(
  prisma: IReportPrismaClient,
  webPageId: string
): Promise<ReportMotionPattern[]> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT type,
            name,
            category,
            trigger_type AS trigger,
            (animation->>'duration')::numeric AS duration,
            animation->'easing'->>'type' AS easing
     FROM motion_patterns
     WHERE web_page_id = $1::uuid
     ORDER BY created_at ASC`,
    webPageId
  )) as Array<{
    type: string;
    name: string | null;
    category: string;
    trigger: string;
    duration: number | null;
    easing: string | null;
  }>;

  return rows.map((m) => ({
    type: m.type,
    name: m.name,
    category: m.category,
    trigger: m.trigger,
    duration: m.duration,
    easing: m.easing,
  }));
}

async function fetchQuality(
  prisma: IReportPrismaClient,
  webPageId: string
): Promise<ReportQuality | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT overall_score, grade,
            (anti_ai_cliche->>'overall_score')::numeric AS anti_ai_cliche,
            (design_quality->>'overall_score')::numeric AS design_quality,
            (technical_quality->>'overall_score')::numeric AS technical_quality
     FROM quality_evaluations
     WHERE target_type = 'web_page' AND target_id = $1::uuid
     ORDER BY created_at DESC
     LIMIT 1`,
    webPageId
  )) as Array<{
    overall_score: number;
    grade: string;
    anti_ai_cliche: number | null;
    design_quality: number | null;
    technical_quality: number | null;
  }>;

  const row = rows[0];
  if (!row) return null;

  return {
    overallScore: row.overall_score,
    grade: row.grade,
    antiAiCliche: row.anti_ai_cliche,
    designQuality: row.design_quality,
    technicalQuality: row.technical_quality,
  };
}

// =====================================================
// Screenshot Reader / スクリーンショット読み込み
// =====================================================

/**
 * スクリーンショットを Base64 として読み込む
 * Path Traversal 防御 (CWE-22) 付き
 */
export async function readScreenshotAsBase64(
  screenshotFullUrl: string | null
): Promise<string | null> {
  if (!screenshotFullUrl) return null;

  try {
    if (screenshotFullUrl.startsWith("data:image/")) {
      return screenshotFullUrl.replace(/^data:image\/\w+;base64,/, "");
    }

    const ALLOWED_ROOT_RAW = path.resolve(resolveScreenshotRootRaw());
    let allowedRoot: string;
    try {
      allowedRoot = await fs.realpath(ALLOWED_ROOT_RAW);
    } catch {
      allowedRoot = ALLOWED_ROOT_RAW;
    }

    const resolved = await fs.realpath(path.resolve(screenshotFullUrl));
    if (!resolved.startsWith(allowedRoot + path.sep) && resolved !== allowedRoot) {
      logger.warn("[ReportTemplate] Screenshot path outside allowed root", {
        path: resolved.slice(0, 30) + "...",
      });
      return null;
    }

    const buf = await fs.readFile(resolved);
    return buf.toString("base64");
  } catch (error) {
    logger.warn("[ReportTemplate] Screenshot read failed", {
      error: (error as Error).message,
    });
    return null;
  }
}

// =====================================================
// Data Aggregation / データ集約
// =====================================================

async function aggregateReportData(
  webPageId: string,
  options: {
    includeScreenshot: boolean;
    includeMotion: boolean;
    includeQuality: boolean;
  }
): Promise<ReportData | null> {
  const factory = getReportPrismaClientFactory();
  if (!factory) return null;

  const prisma = factory();

  const page = await fetchWebPage(prisma, webPageId);
  if (!page) return null;

  const screenshotBase64 = options.includeScreenshot
    ? await readScreenshotAsBase64(page.screenshot_full_url)
    : null;

  const sections = await fetchSections(prisma, webPageId);
  const motionPatterns = options.includeMotion ? await fetchMotions(prisma, webPageId) : [];
  const quality = options.includeQuality ? await fetchQuality(prisma, webPageId) : null;

  return {
    webPage: {
      id: page.id,
      url: page.url,
      title: page.title,
      analyzedAt: page.analyzed_at?.toISOString() ?? null,
      screenshotBase64,
    },
    sections,
    motionPatterns,
    quality,
    generatedAt: new Date().toISOString(),
  };
}

// =====================================================
// Report Generation / レポート生成
// =====================================================

function generateHtmlReport(data: ReportData, title: string): string {
  const template = getHtmlTemplate();
  return template(
    { title, data },
    { allowProtoPropertiesByDefault: false, allowProtoMethodsByDefault: false }
  );
}

/** デフォルト PDF 生成器（Playwright） */
class PlaywrightPdfGenerator implements IPdfGenerator {
  async generatePdf(htmlContent: string): Promise<Buffer> {
    const { chromium } = await import("playwright");

    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.setContent(htmlContent, { waitUntil: "networkidle" });
      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "1cm", right: "1cm", bottom: "1cm", left: "1cm" },
      });
      return Buffer.from(pdf);
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }
}

// =====================================================
// Main Entry / メインエントリ
// =====================================================

export async function generateReport(input: ReportGenerateInput): Promise<ReportGenerateResult> {
  const includeScreenshot = input.includeScreenshot ?? true;
  const includeMotion = input.includeMotion ?? true;
  const includeQuality = input.includeQuality ?? true;

  const data = await aggregateReportData(input.webPageId, {
    includeScreenshot,
    includeMotion,
    includeQuality,
  });

  if (!data) {
    return {
      success: false,
      error: `${REPORT_ERROR_CODES.PAGE_NOT_FOUND}: Web page not found or no analysis data`,
    };
  }

  const title = input.title ?? `Reftrix Report — ${data.webPage.title ?? data.webPage.url}`;

  let htmlContent: string;
  try {
    htmlContent = generateHtmlReport(data, title);
  } catch (error) {
    logger.warn("[ReportTemplate] HTML generation failed", {
      error: sanitizeErrorMessage(error),
    });
    return {
      success: false,
      error: `${REPORT_ERROR_CODES.TEMPLATE_ERROR}: ${sanitizeErrorMessage(error)}`,
    };
  }

  if (input.format === "html") {
    return {
      success: true,
      format: "html",
      content: htmlContent,
      contentSizeBytes: Buffer.byteLength(htmlContent, "utf-8"),
    };
  }

  // PDF変換: DI ファクトリ経由 or デフォルト Playwright
  try {
    const pdfFactory = getPdfGeneratorFactory();
    const pdfGenerator = pdfFactory ? pdfFactory() : new PlaywrightPdfGenerator();
    const pdfBuffer = await pdfGenerator.generatePdf(htmlContent);
    return {
      success: true,
      format: "pdf",
      content: pdfBuffer.toString("base64"),
      contentSizeBytes: pdfBuffer.length,
    };
  } catch (error) {
    logger.warn("[ReportTemplate] PDF conversion failed", {
      error: sanitizeErrorMessage(error),
    });
    return {
      success: false,
      error: `${REPORT_ERROR_CODES.PDF_CONVERSION_FAILED}: ${sanitizeErrorMessage(error)}`,
    };
  }
}
