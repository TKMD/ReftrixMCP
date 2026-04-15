// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * responsive.capture MCPツール
 * 3ビューポート（desktop/tablet/mobile）同時キャプチャ + レスポンシブ差分分析
 *
 * 機能:
 * - 3ビューポート並列キャプチャ（Promise.all）
 * - セクション表示/非表示、フォントサイズ、グリッドカラム、スペーシングの差分検出
 * - 差分スコア計算（0-100、低いほど差分大）
 * - SSRF検証、メモリ圧力チェック
 *
 * @module tools/responsive/capture.tool
 */

import { ZodError } from "zod";
import { logger, isDevelopment } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { validateExternalUrl } from "../../utils/url-validator";
import {
  responsiveCaptureInputSchema,
  RESPONSIVE_CAPTURE_ERROR_CODES,
  type ResponsiveCaptureInput as ResponsiveCaptureInputType,
} from "./capture.schemas";
import type {
  MultiDeviceCaptureService,
  MultiDeviceCaptureResult,
  MultiDeviceCaptureOptions,
} from "../../services/responsive/multi-device-capture.service";
import type {
  ResponsiveDiffService,
  ResponsiveDiffResult,
} from "../../services/responsive/responsive-diff.service";

// ============================================================================
// 型定義 / Types
// ============================================================================

export type ResponsiveCaptureInput = ResponsiveCaptureInputType;

export type ResponsiveCaptureOutput =
  | {
      success: true;
      data: {
        url: string;
        captures: Array<{
          viewport: { name: string; width: number; height: number };
          sections: Array<{
            selector: string;
            tagName: string;
            display: string;
            visibility: string;
          }>;
          documentHeight: number;
          screenshotSize: number;
          error?: string;
        }>;
        diff: {
          score: number;
          changes: Array<{
            element: string;
            type: string;
            description: string;
            details: Record<string, unknown>;
          }>;
        };
        captureTimeMs: number;
      };
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
    };

// ============================================================================
// サービスファクトリー（DI） / Service Factories (DI)
// ============================================================================

type CaptureServiceFactory = () => MultiDeviceCaptureService;
type DiffServiceFactory = () => ResponsiveDiffService;

let captureServiceFactory: CaptureServiceFactory | null = null;
let diffServiceFactory: DiffServiceFactory | null = null;

export function setResponsiveCaptureServiceFactory(
  captureFactory: CaptureServiceFactory,
  diffFactory: DiffServiceFactory
): void {
  captureServiceFactory = captureFactory;
  diffServiceFactory = diffFactory;
}

export function resetResponsiveCaptureServiceFactory(): void {
  captureServiceFactory = null;
  diffServiceFactory = null;
}

// Re-export error codes
export { RESPONSIVE_CAPTURE_ERROR_CODES };

// ============================================================================
// エラーコード判定 / Error Code Mapping
// ============================================================================

function mapErrorToCode(error: Error): string {
  const message = error.message.toLowerCase();

  if (message.includes("ssrf")) {
    return RESPONSIVE_CAPTURE_ERROR_CODES.SSRF_BLOCKED;
  }

  if (message.includes("memory pressure")) {
    return RESPONSIVE_CAPTURE_ERROR_CODES.MEMORY_PRESSURE;
  }

  if (
    message.includes("timeout") ||
    message.includes("navigation") ||
    message.includes("browser")
  ) {
    return RESPONSIVE_CAPTURE_ERROR_CODES.CAPTURE_FAILED;
  }

  return RESPONSIVE_CAPTURE_ERROR_CODES.INTERNAL_ERROR;
}

// ============================================================================
// メインハンドラー / Main Handler
// ============================================================================

const DEFAULT_TIMEOUT_MS = 30_000;

export async function responsiveCaptureHandler(input: unknown): Promise<ResponsiveCaptureOutput> {
  const startTime = Date.now();

  if (isDevelopment()) {
    logger.info("[MCP Tool] responsive.capture called", {
      url: (input as Record<string, unknown>)?.url,
    });
  }

  // 入力バリデーション / Input validation
  let validated: ResponsiveCaptureInputType;
  try {
    validated = responsiveCaptureInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");

      logger.warn("[MCP Tool] responsive.capture validation error", {
        error: errorMessage,
      });

      return {
        success: false,
        error: {
          code: RESPONSIVE_CAPTURE_ERROR_CODES.VALIDATION_ERROR,
          message: `Validation error: ${errorMessage}`,
        },
      };
    }
    throw error;
  }

  // SSRF検証（ツールハンドラー層 Defense-in-Depth）/ SSRF validation (tool handler layer Defense-in-Depth)
  const urlValidation = validateExternalUrl(validated.url);
  if (!urlValidation.valid) {
    logger.warn("[MCP Tool] responsive.capture SSRF blocked", {
      url: validated.url,
      error: urlValidation.error,
    });
    return {
      success: false,
      error: {
        code: RESPONSIVE_CAPTURE_ERROR_CODES.SSRF_BLOCKED,
        message: urlValidation.error ?? "URL validation failed",
      },
    };
  }

  // サービスファクトリーチェック / Service factory check
  if (!captureServiceFactory || !diffServiceFactory) {
    logger.warn("[MCP Tool] responsive.capture service factory not set");

    return {
      success: false,
      error: {
        code: RESPONSIVE_CAPTURE_ERROR_CODES.SERVICE_UNAVAILABLE,
        message: "Responsive capture service is not available",
      },
    };
  }

  const captureService = captureServiceFactory();
  const diffService = diffServiceFactory();

  try {
    // ビューポート構築 / Build viewports
    // exactOptionalPropertyTypes対応: 条件付きで構築
    const baseOptions: MultiDeviceCaptureOptions = {
      timeout: DEFAULT_TIMEOUT_MS,
      includeScreenshots: validated.include_screenshots,
    };
    if (validated.viewports) {
      baseOptions.viewports = validated.viewports.map((v) => ({
        name: v.name,
        width: v.width,
        height: v.height,
      }));
    }

    // キャプチャ実行 / Execute capture
    const captureResult: MultiDeviceCaptureResult = await captureService.captureAllDevices(
      validated.url,
      baseOptions
    );

    // 差分分析 / Diff analysis
    let diffResult: ResponsiveDiffResult = { score: 100, changes: [] };
    if (validated.include_diff) {
      const captureData = captureResult.captures.map((c) => ({
        viewport: c.viewport,
        sections: c.sections,
        documentHeight: c.documentHeight,
        viewportWidth: c.viewportWidth,
        viewportHeight: c.viewportHeight,
      }));
      diffResult = diffService.computeDiff(captureData);
    }

    const captureTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info("[MCP Tool] responsive.capture completed", {
        url: validated.url,
        viewportCount: captureResult.captures.length,
        diffScore: diffResult.score,
        changeCount: diffResult.changes.length,
        captureTimeMs,
      });
    }

    return {
      success: true,
      data: {
        url: validated.url,
        captures: captureResult.captures.map((c) => ({
          viewport: c.viewport,
          sections: c.sections.map((s) => ({
            selector: s.selector,
            tagName: s.tagName,
            display: s.display,
            visibility: s.visibility,
          })),
          documentHeight: c.documentHeight,
          screenshotSize: c.screenshotSize,
          ...(c.error ? { error: c.error } : {}),
        })),
        diff: {
          score: diffResult.score,
          changes: diffResult.changes.map((ch) => ({
            element: ch.element,
            type: ch.type,
            description: ch.description,
            details: ch.details,
          })),
        },
        captureTimeMs,
      },
    };
  } catch (error) {
    const errorInstance = error instanceof Error ? error : new Error(String(error));
    const errorCode = mapErrorToCode(errorInstance);

    logger.error("[MCP Tool] responsive.capture error", {
      code: errorCode,
      error: errorInstance.message,
    });

    return {
      success: false,
      error: {
        code: errorCode,
        message: sanitizeErrorMessage(error),
      },
    };
  } finally {
    // ブラウザのクリーンアップはサービス側で管理
    // Browser cleanup is managed by the service
    await captureService.close().catch(() => {});
  }
}

// ============================================================================
// ツール定義 / Tool Definition
// ============================================================================

export const responsiveCaptureToolDefinition = {
  name: "responsive.capture",
  description:
    "3ビューポート（desktop 1920x1080, tablet 768x1024, mobile 375x812）で" +
    "Webページを同時キャプチャし、レスポンシブレイアウトの差分を分析します。" +
    "セクション表示/非表示、フォントサイズ変化、グリッドカラム変化、" +
    "スペーシング変化を検出し、差分スコア（0-100）を返します。",
  annotations: {
    title: "Responsive Capture",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      url: {
        type: "string",
        description: "キャプチャ対象URL / Target URL for capture",
        format: "uri",
      },
      viewports: {
        type: "array",
        description:
          "カスタムビューポート配列（任意、最大4つ。未指定時: desktop 1920x1080, tablet 768x1024, mobile 375x812） / Custom viewports (optional, max 4)",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "ビューポート名" },
            width: {
              type: "number",
              description: "ビューポート幅（px）",
              minimum: 1,
              maximum: 4096,
            },
            height: {
              type: "number",
              description: "ビューポート高さ（px）",
              minimum: 1,
              maximum: 4096,
            },
          },
          required: ["name", "width", "height"],
        },
        maxItems: 4,
      },
      include_screenshots: {
        type: "boolean",
        description:
          "スクリーンショットサイズを結果に含めるか（デフォルト: false） / Include screenshot sizes in result (default: false)",
        default: false,
      },
      include_diff: {
        type: "boolean",
        description:
          "レスポンシブ差分分析を含めるか（デフォルト: true） / Include responsive diff analysis (default: true)",
        default: true,
      },
    },
    required: ["url"],
  },
};

if (isDevelopment()) {
  logger.debug("[responsive.capture] Tool module loaded");
}
