// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * accessibility.audit MCPツールハンドラー
 *
 * axe-coreベースのWCAG 2.1 AA準拠監査 + OKLCHコントラストチェックを統合した
 * アクセシビリティ監査ツール。
 *
 * accessibility.audit MCP tool handler
 * Integrated accessibility audit tool combining axe-core WCAG 2.1 AA compliance
 * audit with OKLCH contrast checking.
 *
 * @module tools/accessibility/audit.tool
 */

import { z, ZodError } from "zod";
import { createDIFactory } from "../../utils/di-factory";
import { logger, isDevelopment } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import {
  formatZodError,
  createValidationErrorWithHints,
  formatMultipleDetailedErrors,
} from "../../utils/error-messages";
import { validateExternalUrl } from "../../utils/url-validator";
import { sanitizeHtml } from "../../utils/html-sanitizer";

import type {
  AccessibilityAuditService,
  AuditViolation,
  AuditPass,
  AuditSummary,
} from "../../services/quality/accessibility-audit.service";
import type {
  ContrastCheckService,
  ContrastIssue,
} from "../../services/quality/contrast-check.service";

// =====================================================
// エラーコード / Error Codes
// =====================================================

export const ACCESSIBILITY_AUDIT_ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  SSRF_BLOCKED: "SSRF_BLOCKED",
  FETCH_FAILED: "FETCH_FAILED",
} as const;

export type AccessibilityAuditErrorCode =
  (typeof ACCESSIBILITY_AUDIT_ERROR_CODES)[keyof typeof ACCESSIBILITY_AUDIT_ERROR_CODES];

// =====================================================
// Zodスキーマ / Zod Schema
// =====================================================

const wcagLevelSchema = z.enum(["A", "AA", "AAA"]);

export const accessibilityAuditInputSchema = z
  .object({
    /** URL to audit (mutually exclusive with html) */
    url: z.string().url().optional(),
    /** HTML content to audit (mutually exclusive with url) */
    html: z.string().min(1).max(10_000_000).optional(),
    /** WCAG level (default: 'AA') */
    level: wcagLevelSchema.default("AA"),
    /** Include contrast check (default: true) */
    include_contrast: z.boolean().default(true),
    /** Include passed rules (default: false) */
    include_passes: z.boolean().default(false),
  })
  .refine((data) => data.url !== undefined || data.html !== undefined, {
    message: "Either url or html must be provided",
    path: ["url"],
  });

export type AccessibilityAuditInput = z.infer<typeof accessibilityAuditInputSchema>;

// =====================================================
// 出力型 / Output Types
// =====================================================

export interface AccessibilityAuditData {
  score: number;
  level: string;
  violations: AuditViolation[];
  passes?: AuditPass[];
  contrast_issues?: ContrastIssue[];
  summary: AuditSummary;
}

export type AccessibilityAuditOutput =
  | {
      success: true;
      data: AccessibilityAuditData;
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
        details?: unknown;
      };
    };

// =====================================================
// DI Factories
// =====================================================

const auditServiceDI = createDIFactory<AccessibilityAuditService>("AccessibilityAuditService");
export const setAccessibilityAuditServiceFactory = auditServiceDI.set;
export const resetAccessibilityAuditServiceFactory = auditServiceDI.reset;

const contrastServiceDI = createDIFactory<ContrastCheckService>("ContrastCheckService");
export const setContrastCheckServiceFactory = contrastServiceDI.set;
export const resetContrastCheckServiceFactory = contrastServiceDI.reset;

// =====================================================
// ハンドラー / Handler
// =====================================================

/**
 * accessibility.audit ツールハンドラー
 *
 * @param input - ツール入力
 * @returns 監査結果
 */
export async function accessibilityAuditHandler(input: unknown): Promise<AccessibilityAuditOutput> {
  if (isDevelopment()) {
    logger.info("[MCP Tool] accessibility.audit called", {
      hasInput: input !== null && input !== undefined,
    });
  }

  // 入力バリデーション
  let validated: AccessibilityAuditInput;
  try {
    validated = accessibilityAuditInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorWithHints = createValidationErrorWithHints(error, "accessibility.audit");
      const detailedMessage = formatMultipleDetailedErrors(errorWithHints.errors);
      const formattedErrors = formatZodError(error);

      logger.warn("[MCP Tool] accessibility.audit validation error", {
        error: (error as Error).message,
      });

      return {
        success: false,
        error: {
          code: ACCESSIBILITY_AUDIT_ERROR_CODES.VALIDATION_ERROR,
          message: `Validation error:\n${detailedMessage}`,
          details: {
            errors: formattedErrors,
            detailedErrors: errorWithHints.errors,
          },
        },
      };
    }
    throw error;
  }

  // SSRF検証（URL入力の場合）
  if (validated.url) {
    const urlValidation = validateExternalUrl(validated.url);
    if (!urlValidation.valid) {
      logger.warn("[MCP Tool] accessibility.audit SSRF blocked", {
        url: validated.url,
        error: urlValidation.error,
      });
      return {
        success: false,
        error: {
          code: ACCESSIBILITY_AUDIT_ERROR_CODES.SSRF_BLOCKED,
          message: urlValidation.error ?? "URL validation failed",
        },
      };
    }
  }

  // DIファクトリチェック
  const auditFactory = auditServiceDI.get();
  if (!auditFactory) {
    logger.warn("[MCP Tool] accessibility.audit: service factory not registered");
    return {
      success: false,
      error: {
        code: ACCESSIBILITY_AUDIT_ERROR_CODES.SERVICE_UNAVAILABLE,
        message: "Accessibility audit service is not available",
      },
    };
  }

  let html = validated.html;

  // URL入力の場合はFetchで取得
  if (validated.url && !html) {
    try {
      const response = await fetch(validated.url, {
        signal: AbortSignal.timeout(30000),
        headers: {
          "User-Agent": "Reftrix-AccessibilityAudit/1.0",
        },
      });
      if (!response.ok) {
        return {
          success: false,
          error: {
            code: ACCESSIBILITY_AUDIT_ERROR_CODES.FETCH_FAILED,
            message: `Failed to fetch URL: HTTP ${response.status}`,
          },
        };
      }
      const rawHtml = await response.text();
      // SEC-P75-01: URL入力パスで取得したHTMLをサニタイズ
      // page.analyze統合パスでは既にサニタイズ済みHTMLが渡される
      html = sanitizeHtml(rawHtml, { preserveDocumentStructure: true });
    } catch (error) {
      logger.warn("[MCP Tool] accessibility.audit fetch error", {
        url: validated.url,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return {
        success: false,
        error: {
          code: ACCESSIBILITY_AUDIT_ERROR_CODES.FETCH_FAILED,
          message: sanitizeErrorMessage(error),
        },
      };
    }
  }

  if (!html) {
    return {
      success: false,
      error: {
        code: ACCESSIBILITY_AUDIT_ERROR_CODES.VALIDATION_ERROR,
        message: "No HTML content available for audit",
      },
    };
  }

  try {
    const auditService = auditFactory();

    // WCAG監査実行
    const auditResult = await auditService.audit(html, {
      includePasses: validated.include_passes,
    });

    // レスポンスデータ構築
    const data: AccessibilityAuditData = {
      score: auditResult.score,
      level: auditResult.level,
      violations: auditResult.violations,
      summary: auditResult.summary,
    };

    // passes
    if (validated.include_passes && auditResult.passes.length > 0) {
      data.passes = auditResult.passes;
    }

    // コントラストチェック
    if (validated.include_contrast) {
      const contrastFactory = contrastServiceDI.get();
      if (contrastFactory) {
        try {
          const contrastService = contrastFactory();
          const contrastResult = await contrastService.checkHtmlContrast(html);
          data.contrast_issues = contrastResult.issues;
        } catch (contrastError) {
          // Graceful degradation: コントラストチェック失敗時は空配列
          logger.warn(
            "[MCP Tool] accessibility.audit contrast check failed (graceful degradation)",
            {
              error: contrastError instanceof Error ? contrastError.message : "Unknown error",
            }
          );
          data.contrast_issues = [];
        }
      } else {
        // コントラストサービス未登録時も空配列
        data.contrast_issues = [];
      }
    }

    if (isDevelopment()) {
      logger.info("[MCP Tool] accessibility.audit completed", {
        score: data.score,
        level: data.level,
        violationCount: data.violations.length,
        contrastIssueCount: data.contrast_issues?.length ?? 0,
      });
    }

    return {
      success: true,
      data,
    };
  } catch (error) {
    logger.warn("[MCP Tool] accessibility.audit error", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return {
      success: false,
      error: {
        code: ACCESSIBILITY_AUDIT_ERROR_CODES.INTERNAL_ERROR,
        message: sanitizeErrorMessage(error),
      },
    };
  }
}

// =====================================================
// ツール定義 / Tool Definition
// =====================================================

export const accessibilityAuditToolDefinition = {
  name: "accessibility.audit",
  description:
    "WCAG 2.1 accessibility audit using axe-core with contrast ratio checking. " +
    "Analyzes HTML or URL for WCAG A/AA/AAA compliance, detects violations with severity classification, " +
    "calculates accessibility score (0-100), and checks text/background contrast ratios.",
  annotations: {
    title: "Accessibility Audit",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      url: {
        type: "string",
        format: "uri",
        description: "URL to audit (mutually exclusive with html). SSRF-validated.",
      },
      html: {
        type: "string",
        minLength: 1,
        maxLength: 10000000,
        description: "HTML content to audit directly (max 10MB, mutually exclusive with url).",
      },
      level: {
        type: "string",
        enum: ["A", "AA", "AAA"],
        default: "AA",
        description: "WCAG conformance level to check (default: AA).",
      },
      include_contrast: {
        type: "boolean",
        default: true,
        description:
          "Include OKLCH-based contrast ratio check for text/background pairs (default: true).",
      },
      include_passes: {
        type: "boolean",
        default: false,
        description: "Include passed accessibility rules in response (default: false).",
      },
    },
  },
};
