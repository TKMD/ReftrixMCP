// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * design.verify_reproduction MCP tool
 * Compare an LLM-written HTML/CSS reproduction against a stored section and return structured
 * differences to fix (generate -> verify -> fix loop).
 *
 * Security:
 * - the candidate is rendered offline with JavaScript disabled; every non-`data:` request is
 *   aborted and only counted (INV-SEC-VERIFY-REPRO-OFFLINE-001 / INV-SEC-VERIFY-REPRO-NO-JS-001);
 * - the candidate is never stored, logged or echoed;
 * - Zod strict objects + size caps (CWE-770); errors go through sanitizeErrorMessage (CWE-209);
 * - read-only: no screenshot / crop / cache file is written (INV-CROP-NO-WRITE-001).
 *
 * @module tools/design/verify-reproduction.tool
 */

import { z } from "zod";
import { createDIFactory } from "../../utils/di-factory";
import { logger } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { formatIssueLine } from "../../utils/issue-path";
import {
  VerifyNotFoundError,
  verifyReproduction,
  type VerifyDeps,
  type VerifyResult,
} from "../../services/design/reproduction-verify.service";

// =====================================================
// Limits
// =====================================================

/** Candidate html + css together, in UTF-8 bytes. */
export const MAX_CANDIDATE_TOTAL_BYTES = 2 * 1024 * 1024;
/** Each `data:` URI inside the candidate, in characters. */
export const MAX_DATA_URI_BYTES = 1024 * 1024;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Longest `data:` URI in the text (linear scan, no backtracking). */
export function longestDataUri(text: string): number {
  let max = 0;
  const re = /data:[^\s"'()<>]*/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length > max) max = m[0].length;
  }
  return max;
}

// =====================================================
// Input schema
// =====================================================

export const verifyReproductionInputSchema = z
  .strictObject({
    pattern_id: z
      .string()
      .regex(UUID_PATTERN, "Invalid UUID format")
      .describe("section_patterns.id of the stored section to compare against"),
    candidate: z.strictObject({
      html: z.string().min(1).max(MAX_CANDIDATE_TOTAL_BYTES),
      css: z.string().max(MAX_CANDIDATE_TOTAL_BYTES).optional(),
    }),
    options: z
      .strictObject({
        max_diffs: z.number().int().min(1).max(50).default(20),
        include_diff_image: z.boolean().default(false),
        mask_images: z.boolean().default(true),
        ignore_text: z.boolean().default(false),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    const html = value.candidate.html;
    const css = value.candidate.css ?? "";
    const total = Buffer.byteLength(html, "utf8") + Buffer.byteLength(css, "utf8");
    if (total > MAX_CANDIDATE_TOTAL_BYTES) {
      ctx.addIssue({
        code: "custom",
        path: ["candidate"],
        message: `candidate html + css must be at most ${MAX_CANDIDATE_TOTAL_BYTES} bytes`,
      });
    }
    if (Math.max(longestDataUri(html), longestDataUri(css)) > MAX_DATA_URI_BYTES) {
      ctx.addIssue({
        code: "custom",
        path: ["candidate"],
        message: `each data: URI must be at most ${MAX_DATA_URI_BYTES} bytes`,
      });
    }
  });

export type VerifyReproductionInput = z.infer<typeof verifyReproductionInputSchema>;

// =====================================================
// Output / errors
// =====================================================

export const DESIGN_VERIFY_ERROR_CODES = {
  INVALID_INPUT: "INVALID_INPUT",
  NOT_FOUND: "NOT_FOUND",
  RENDER_FAILED: "RENDER_FAILED",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type VerifyReproductionOutput =
  | ({ success: true } & VerifyResult)
  | { success: false; error: string };

// =====================================================
// DI
// =====================================================

const depsDI = createDIFactory<VerifyDeps>("DesignVerifyReproductionDeps");
export const setDesignVerifyReproductionDepsFactory = depsDI.set;
export const resetDesignVerifyReproductionDepsFactory = depsDI.reset;

// =====================================================
// Handler
// =====================================================

export async function designVerifyReproductionHandler(
  input: unknown
): Promise<VerifyReproductionOutput> {
  const startTime = Date.now();
  const parsedResult = verifyReproductionInputSchema.safeParse(input);
  if (!parsedResult.success) {
    const message = parsedResult.error.issues.map((e) => formatIssueLine(e)).join("; ");
    return {
      success: false,
      error: `${DESIGN_VERIFY_ERROR_CODES.INVALID_INPUT}: ${message}`,
    };
  }
  const parsed = parsedResult.data;

  const depsFactory = depsDI.get();
  if (!depsFactory) {
    return {
      success: false,
      error: `${DESIGN_VERIFY_ERROR_CODES.SERVICE_UNAVAILABLE}: verification service not available`,
    };
  }

  try {
    const result = await verifyReproduction(
      {
        patternId: parsed.pattern_id,
        html: parsed.candidate.html,
        css: parsed.candidate.css ?? "",
        maxDiffs: parsed.options?.max_diffs ?? 20,
        includeDiffImage: parsed.options?.include_diff_image ?? false,
        maskImages: parsed.options?.mask_images ?? true,
        ignoreText: parsed.options?.ignore_text ?? false,
      },
      depsFactory()
    );
    return { success: true, ...result };
  } catch (error) {
    if (error instanceof VerifyNotFoundError) {
      return {
        success: false,
        error: `${DESIGN_VERIFY_ERROR_CODES.NOT_FOUND}: section pattern not found`,
      };
    }
    // Server log keeps the raw message (never the candidate); the client gets a fixed message.
    logger.error("[design.verify_reproduction] failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      error: `${DESIGN_VERIFY_ERROR_CODES.RENDER_FAILED}: ${sanitizeErrorMessage(error)}`,
    };
  } finally {
    logger.info("[design.verify_reproduction] completed", {
      processingTimeMs: Date.now() - startTime,
    });
  }
}

// =====================================================
// Tool definition (JSON Schema is the AI-facing contract)
// =====================================================

export const designVerifyReproductionToolDefinition = {
  name: "design.verify_reproduction",
  description:
    "LLMが書いたHTML/CSSの再現が保存済みセクションにどれだけ近いかを検証し、直すべき差分（位置・サイズなど）を構造化して返します。候補はオフライン・JS無効で描画され、外部リクエストは全て遮断（件数のみ返却）。画像・Webフォントは読み込まれないためdata: URIでインライン化してください。スクリーンショットが期限切れでもピクセル比較のみ省略して他は実行します。フォント・色などのスタイル差分は参照側に計算済みスタイルが保存されている場合のみ返ります。レイアウトとスタイルを学ぶための参考用です。第三者の本文・画像・ロゴ・商標は自分のものに置き換えてください（本文の一致はスコアに影響します。options.ignore_text=true で本文をレイアウト・スタイルの照合から外せます。ピクセル・視覚スコアは描画画像を比較するため文字の見た目は残ります）。元サイトの権利と利用規約の確認は利用者の責任です。" +
    " / Verify how closely your HTML/CSS reproduces a stored section and get structured differences (position, size, ...) to fix. The candidate is rendered offline with JavaScript disabled; every external request is blocked (only the count is returned), so inline images and fonts as data: URIs. If the reference screenshot has expired, only the pixel comparison is skipped. Style differences (font, color, ...) are returned only when the stored reference has computed styles. For learning layout and style only: replace third-party text, images, logos and trademarks with your own (matching text raises the score; set options.ignore_text=true to leave text out of the layout/style match - pixel and visual scores still compare the rendered image, so glyph appearance remains); respecting the source site's rights and terms is your responsibility.",
  annotations: {
    title: "Design Verify Reproduction",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      pattern_id: {
        type: "string",
        format: "uuid",
        description:
          "比較対象セクション（section_patterns.id） / Stored section id to compare against",
      },
      candidate: {
        type: "object",
        additionalProperties: false,
        properties: {
          html: {
            type: "string",
            minLength: 1,
            description:
              "再現HTML（body内の断片）。html+css合計2MiB以下、各data: URIは1MiB以下 / Reproduction HTML fragment; html+css at most 2 MiB total, each data: URI at most 1 MiB",
          },
          css: {
            type: "string",
            description: "再現CSS（任意） / Reproduction CSS (optional)",
          },
        },
        required: ["html"],
      },
      options: {
        type: "object",
        additionalProperties: false,
        properties: {
          max_diffs: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            default: 20,
            description: "返す差分の最大件数 / Maximum number of diffs returned",
          },
          include_diff_image: {
            type: "boolean",
            default: false,
            description: "256px幅の差分ヒートマップを含める / Include a ≤256px-wide diff heat-map",
          },
          mask_images: {
            type: "boolean",
            default: true,
            description:
              "画像パーツ領域をピクセル比較から除外 / Mask image parts in the pixel comparison",
          },
          ignore_text: {
            type: "boolean",
            default: false,
            description:
              "本文をパーツの対応付け・テキストプレビューから外す（レイアウト・スタイル照合は継続。ピクセル・視覚スコアは描画画像のまま）。結果に textIgnored:true を返す / Leave text out of part pairing and text previews (layout and style still compared; pixel and visual scores still use the rendered image). The result carries textIgnored:true",
          },
        },
      },
    },
    required: ["pattern_id", "candidate"],
  },
};
