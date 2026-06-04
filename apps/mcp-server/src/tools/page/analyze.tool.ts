// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze MCPツール
 * URLを指定してlayout/motion/qualityの3分析を並列実行し、統合レスポンスを返す
 *
 * @module tools/page/analyze.tool
 */

import { v7 as uuidv7 } from "uuid";
import { createDIFactory } from "../../utils/di-factory";
import { logger, isDevelopment } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { validateExternalUrl, normalizeUrlForValidation } from "../../utils/url-validator";
import { isUrlAllowedByRobotsTxt } from "@reftrixmcp/core";
import { assertNonProductionFactory } from "../../services/production-guard";

// Embedding統合用インポート（ハンドラーから再エクスポート）
import { generateSectionTextRepresentation as generateSectionTextRepresentationFromHandler } from "./handlers/embedding-handler";

// Types Handler（共通型定義）
import {
  type IPageAnalyzeService,
  type IPageAnalyzePrismaClient,
  type MotionPatternInput,
} from "./handlers/types";

import {
  pageAnalyzeInputSchema,
  PAGE_ANALYZE_ERROR_CODES,
  type PageAnalyzeInput,
  type PageAnalyzeOutput,
  type PageAnalyzeAsyncOutput,
} from "./schemas";

// Async mode support (Phase3-2)
import { isRedisAvailable } from "../../config/redis";
import {
  createPageAnalyzeQueue,
  addPageAnalyzeJobWithGuard,
  closeQueue,
  type PageAnalyzeJobOptions,
} from "../../queues/page-analyze-queue";

// WorkerSupervisor: ワーカープロセスの自動管理（OOM対策）
import { bootstrapWorkersForPageAnalyze } from "./_shared/worker-bootstrap";

// Queue Cleanup: バッチ投入前のorphaned job自動クリーンアップ
import { cleanupQueue, createQueueAdapter } from "../../services/queue-cleanup.service";

// タイムアウトユーティリティ（Phase 5: Graceful Degradation）
import { PhaseTimeoutError } from "./handlers/timeout-utils";

// Vision CPU完走保証 Phase 4: MCP進捗報告統合
import type { ProgressContext } from "../../router";

// v0.3.0: Streaming Progress Notifications (MCP progressToken統合)
import { ProgressNotificationService } from "../../services/progress-notification.service";

// 同期処理ロジック（handlers/sync-processing.tsに分離）
import { executeSyncProcessing } from "./handlers/sync-processing";

// =====================================================
// Embedding用テキスト表現生成関数（再エクスポート）
// =====================================================

// 型定義はハンドラーから再エクスポート
export type { SectionPatternInput } from "./handlers/embedding-handler";
export type { MotionPatternInput } from "./handlers/types";

/**
 * セクションからEmbedding用テキスト表現を生成
 * ハンドラーモジュールに移動済み - 後方互換性のため再エクスポート
 */
export { generateSectionTextRepresentationFromHandler as generateSectionTextRepresentation };

/**
 * モーションパターンからEmbedding用テキスト表現を生成
 *
 * E5モデル用にpassage:プレフィックスを付与
 * 768次元ベクトル生成に最適化されたテキスト形式
 *
 * @param pattern - モーションパターン情報
 * @returns Embedding用テキスト表現（passage:プレフィックス付き）
 */
export function generateMotionTextRepresentation(pattern: MotionPatternInput): string {
  const parts: string[] = [];

  // パターンタイプ
  parts.push(`Motion type: ${pattern.type}`);

  // パターン名
  if (pattern.name) {
    parts.push(`Name: ${pattern.name}`);
  }

  // カテゴリ
  parts.push(`Category: ${pattern.category}`);

  // トリガー
  parts.push(`Trigger: ${pattern.trigger}`);

  // Duration
  if (pattern.duration !== undefined) {
    parts.push(`Duration: ${pattern.duration}ms`);
  }

  // Easing
  if (pattern.easing) {
    parts.push(`Easing: ${pattern.easing}`);
  }

  // プロパティ
  if (pattern.properties && pattern.properties.length > 0) {
    parts.push(`Properties: ${pattern.properties.join(", ")}`);
  }

  return `passage: ${parts.join(". ")}.`;
}

// =====================================================
// 型定義（再エクスポート）
// =====================================================

export type { PageAnalyzeInput, PageAnalyzeOutput };
export type { IPageAnalyzeService, IPageAnalyzePrismaClient } from "./handlers/types";

// =====================================================
// サービスファクトリ（DI用）
// =====================================================

const serviceFactoryDI = createDIFactory<IPageAnalyzeService>("PageAnalyzeService");
export const setPageAnalyzeServiceFactory = serviceFactoryDI.set;
export const resetPageAnalyzeServiceFactory = serviceFactoryDI.reset;

// =====================================================
// Prismaクライアントファクトリ（DI用）
// =====================================================

const prismaClientDI = createDIFactory<IPageAnalyzePrismaClient>("PageAnalyzePrismaClient");

/**
 * PrismaClientファクトリを設定
 *
 * @throws ProductionGuardError 本番環境で上書きを試みた場合
 */
export function setPageAnalyzePrismaClientFactory(factory: () => IPageAnalyzePrismaClient): void {
  // 本番環境で既に設定済みの場合のみ禁止（上書き防止）
  if (prismaClientDI.get() !== null) {
    assertNonProductionFactory("pageAnalyzePrismaClient");
  }
  prismaClientDI.set(factory);
}

export const resetPageAnalyzePrismaClientFactory = prismaClientDI.reset;

/**
 * PrismaClientを取得
 */
function getPrismaClient(): IPageAnalyzePrismaClient | null {
  const factory = prismaClientDI.get();
  if (factory) {
    return factory();
  }
  return null;
}

// DB保存処理はhandlers/db-handler.tsに分離済み

// =====================================================
// メインハンドラー
// =====================================================

/**
 * page.analyze ツールハンドラー
 *
 * @param input - ツール入力パラメータ
 * @param progressContext - MCP進捗報告コンテキスト（Vision CPU完走保証 Phase 4）
 */
export async function pageAnalyzeHandler(
  input: unknown,
  progressContext?: ProgressContext
): Promise<PageAnalyzeOutput> {
  const overallStartTime = Date.now();

  if (isDevelopment()) {
    logger.info("[MCP Tool] page.analyze called", {
      hasInput: input !== null && input !== undefined,
    });
  }

  // 入力バリデーション
  let validated: PageAnalyzeInput;
  try {
    if (input === null || input === undefined) {
      return {
        success: false,
        error: {
          code: PAGE_ANALYZE_ERROR_CODES.VALIDATION_ERROR,
          message: "Input is required",
        },
      };
    }

    validated = pageAnalyzeInputSchema.parse(input);
  } catch (error) {
    logger.warn("[MCP Tool] page.analyze validation error", { error: (error as Error).message });
    return {
      success: false,
      error: {
        code: PAGE_ANALYZE_ERROR_CODES.VALIDATION_ERROR,
        message: sanitizeErrorMessage(error),
      },
    };
  }

  // SSRF対策: URL検証
  const urlValidation = validateExternalUrl(validated.url);
  if (!urlValidation.valid) {
    if (isDevelopment()) {
      logger.warn("[MCP Tool] page.analyze SSRF blocked", {
        url: validated.url,
        error: urlValidation.error,
      });
    }
    return {
      success: false,
      error: {
        code: PAGE_ANALYZE_ERROR_CODES.SSRF_BLOCKED,
        message: urlValidation.error ?? "URL is blocked for security reasons",
      },
    };
  }

  const normalizedUrl = urlValidation.normalizedUrl ?? normalizeUrlForValidation(validated.url);

  // robots.txt チェック（RFC 9309準拠）- 早期ブロック
  const robotsResult = await isUrlAllowedByRobotsTxt(validated.url, validated.respect_robots_txt);
  if (!robotsResult.allowed) {
    return {
      success: false,
      error: {
        code: PAGE_ANALYZE_ERROR_CODES.ROBOTS_TXT_BLOCKED,
        message:
          `Blocked by robots.txt: ${validated.url} (domain: ${robotsResult.domain}, reason: ${robotsResult.reason}). ` +
          `Use respect_robots_txt: false to override. ` +
          `Note: Overriding robots.txt may have legal implications depending on jurisdiction (e.g., EU DSM Directive Article 4).`,
      },
    };
  }

  // =====================================================
  // v0.3.0: Streaming Progress Notification Service
  // =====================================================
  // progressToken が提供されている場合、MCP notifications/progress を送信
  const progressService = new ProgressNotificationService({
    progressToken: progressContext?.progressToken,
    sendNotification: progressContext?.sendNotification
      ? async (notification): Promise<void> => {
          await progressContext.sendNotification(notification);
        }
      : undefined,
  });

  // =====================================================
  // Smart Defaults: Vision有効時の自動非同期モード（v0.1.0）
  // =====================================================
  // Vision LLM (llama3.2-vision) はCPUモードで2-5分以上かかるため、
  // MCPの600秒ハードタイムアウトを回避するために自動的にasyncモードを有効化
  const useVisionEnabled = validated.layoutOptions?.useVision !== false; // デフォルトtrue
  const useNarrativeVisionEnabled = validated.narrativeOptions?.includeVision === true;
  const visionRequested = useVisionEnabled || useNarrativeVisionEnabled;

  // async が明示的に指定されていない場合のみ自動設定
  // (ユーザーが async: false を明示指定した場合は尊重)
  let autoAsyncEnabled = false;
  if (visionRequested && validated.async === undefined) {
    const redisCheck = await isRedisAvailable();
    if (redisCheck) {
      // Vision有効 + Redis利用可能 → 自動でasyncモードを有効化
      validated = { ...validated, async: true };
      autoAsyncEnabled = true;
      if (isDevelopment()) {
        logger.info("[page.analyze] Auto-async enabled for Vision analysis", {
          url: validated.url,
          useVision: useVisionEnabled,
          useNarrativeVision: useNarrativeVisionEnabled,
        });
      }
    } else if (isDevelopment()) {
      logger.warn("[page.analyze] Vision requested but Redis unavailable, sync mode will be used", {
        url: validated.url,
      });
    }
  }

  // =====================================================
  // 非同期モード処理（Phase3-2）
  // =====================================================
  // async=true の場合、ジョブをキューに投入して即座に返す
  if (validated.async === true) {
    if (isDevelopment()) {
      logger.info("[page.analyze] Async mode requested", { url: validated.url });
    }

    // Redis可用性チェック
    const redisAvailable = await isRedisAvailable();
    if (!redisAvailable) {
      if (isDevelopment()) {
        logger.warn("[page.analyze] Redis unavailable for async mode");
      }
      return {
        success: false,
        error: {
          code: "REDIS_UNAVAILABLE",
          message: "Async mode requires Redis. Please start Redis or use sync mode (async=false).",
        },
      };
    }

    // ワーカープロセスが起動していなければ起動する (PR-D-9 Wave 1: C-11 helper)
    // Worker bootstrap via shared helper. ENABLE_BACKFILL_AUTOSPAWN env var
    // controls page-only (legacy) vs page + embedding-backfill staggered spawn.
    // Failures are logged + audit-emitted per ADR-0018 §Decision 1 Supplement.
    bootstrapWorkersForPageAnalyze();

    // ジョブIDとしてwebPageIdを事前生成
    const webPageId = uuidv7();

    // キューにジョブを追加
    const queue = createPageAnalyzeQueue();

    // バッチ投入前: orphaned/failed/stalledジョブを自動クリーンアップ
    const cleanupResult = await cleanupQueue(createQueueAdapter(queue));
    if (cleanupResult.strategy !== "skipped" && isDevelopment()) {
      logger.info("[page.analyze] Queue cleanup before job submission", {
        strategy: cleanupResult.strategy,
        totalCleaned: cleanupResult.totalCleaned,
      });
    }

    try {
      // ジョブオプションを構築（exactOptionalPropertyTypes対応）
      const jobOptions: PageAnalyzeJobOptions = {
        timeout: validated.timeout,
        features: {
          layout: validated.features?.layout,
          motion: validated.features?.motion,
          quality: validated.features?.quality,
        },
      };

      // layoutOptions（デフォルト値を常に設定 — undefinedの場合もデフォルトで構築）
      // Bug fix: デフォルトモード（layoutOptions未指定）でも useVision: true 等が適用されるように
      {
        const src = validated.layoutOptions;
        const layoutOpts: NonNullable<PageAnalyzeJobOptions["layoutOptions"]> = {
          useVision: src?.useVision ?? true,
          saveToDb: src?.saveToDb ?? true,
          autoAnalyze: src?.autoAnalyze ?? true,
          fullPage: src?.fullPage ?? true,
          scrollVision: src?.scrollVision ?? true,
          scrollVisionMaxCaptures: src?.scrollVisionMaxCaptures ?? 10,
        };
        if (src?.viewport) {
          layoutOpts.viewport = src.viewport;
        }
        jobOptions.layoutOptions = layoutOpts;
      }

      // motionOptions
      if (validated.motionOptions) {
        jobOptions.motionOptions = {
          detectJsAnimations: validated.motionOptions.detect_js_animations ?? true,
          detectWebglAnimations: validated.motionOptions.detect_webgl_animations ?? true,
          enableFrameCapture: validated.motionOptions.enable_frame_capture ?? false,
          analyzeFrames: validated.motionOptions.analyze_frames ?? false,
          saveToDb: validated.motionOptions.saveToDb ?? true,
          maxPatterns: validated.motionOptions.maxPatterns ?? 500,
          // v0.1.0: Motion検出タイムアウト（asyncモードでは長時間検出可能）
          timeout: validated.motionOptions.timeout ?? 300000,
        };
      }

      // qualityOptions（undefinedを明示的に除外）
      if (validated.qualityOptions) {
        const qualityOpts: NonNullable<PageAnalyzeJobOptions["qualityOptions"]> = {
          strict: validated.qualityOptions.strict ?? true,
        };
        if (validated.qualityOptions.weights) {
          qualityOpts.weights = {
            originality: validated.qualityOptions.weights.originality ?? 0.35,
            craftsmanship: validated.qualityOptions.weights.craftsmanship ?? 0.4,
            contextuality: validated.qualityOptions.weights.contextuality ?? 0.25,
          };
        }
        if (validated.qualityOptions.targetIndustry) {
          qualityOpts.targetIndustry = validated.qualityOptions.targetIndustry;
        }
        if (validated.qualityOptions.targetAudience) {
          qualityOpts.targetAudience = validated.qualityOptions.targetAudience;
        }
        jobOptions.qualityOptions = qualityOpts;
      }

      // narrativeOptions（デフォルト有効）
      if (validated.narrativeOptions) {
        jobOptions.narrativeOptions = {
          enabled: validated.narrativeOptions.enabled ?? true,
          saveToDb: validated.narrativeOptions.saveToDb ?? true,
          includeVision: validated.narrativeOptions.includeVision ?? true,
          visionTimeoutMs: validated.narrativeOptions.visionTimeoutMs ?? 300000,
          generateEmbedding: validated.narrativeOptions.generateEmbedding ?? true,
        };
      }

      // responsiveOptions（デフォルト有効）
      if (validated.responsiveOptions) {
        const rOpts = validated.responsiveOptions;
        jobOptions.responsiveOptions = {
          enabled: rOpts.enabled ?? true,
          ...(rOpts.viewports !== undefined ? { viewports: rOpts.viewports } : {}),
          ...(rOpts.include_screenshots !== undefined
            ? { include_screenshots: rOpts.include_screenshots }
            : {}),
          ...(rOpts.include_diff_images !== undefined
            ? { include_diff_images: rOpts.include_diff_images }
            : {}),
          ...(rOpts.diff_threshold !== undefined ? { diff_threshold: rOpts.diff_threshold } : {}),
          ...(rOpts.save_to_db !== undefined ? { save_to_db: rOpts.save_to_db } : {}),
          ...(rOpts.detect_navigation !== undefined
            ? { detect_navigation: rOpts.detect_navigation }
            : {}),
          ...(rOpts.detect_visibility !== undefined
            ? { detect_visibility: rOpts.detect_visibility }
            : {}),
          ...(rOpts.detect_layout !== undefined ? { detect_layout: rOpts.detect_layout } : {}),
        };
      }

      // respectRobotsTxt（Workerパスでもrobots.txtチェックに渡す）
      if (validated.respect_robots_txt !== undefined) {
        jobOptions.respectRobotsTxt = validated.respect_robots_txt;
      }

      // Phase 7.5: Accessibility + Performance + Auto Snapshot (v0.3.0)
      if (validated.accessibilityOptions?.enabled) {
        jobOptions.accessibilityOptions = {
          enabled: true,
          level: validated.accessibilityOptions.level,
          include_contrast: validated.accessibilityOptions.include_contrast,
          save_to_db: validated.accessibilityOptions.save_to_db,
        };
      }
      if (validated.performanceOptions?.enabled) {
        jobOptions.performanceOptions = {
          enabled: true,
          include_screenshots: validated.performanceOptions.include_screenshots,
          save_to_db: validated.performanceOptions.save_to_db,
          ...(validated.performanceOptions.budget
            ? { budget: validated.performanceOptions.budget }
            : {}),
        };
      }
      if (validated.auto_snapshot) {
        jobOptions.autoSnapshot = true;
      }

      // PR-D-6 Phase 2: migrate legacy `addPageAnalyzeJob` → collision-guarded
      // SSOT helper. Returns `EnqueueResult` (5-variant discriminated union
      // post PR-D-7 Phase 2 Wave 2 Option Z-a); we branch on `outcome` for
      // observability.
      //
      // ADR-0018 Amendment 11 (Strategy A): the BullMQ jobId is now the
      // URL-stable UUIDv5 (`enqueueResult.jobId`), NOT `webPageId`. The async
      // response surfaces `enqueueResult.jobId` so the client polls the actual
      // BullMQ job (`getJobStatus` does `queue.getJob(jobId)`); `webPageId` is
      // added additively for clients that still need the per-call web_pages id.
      const enqueueResult = await addPageAnalyzeJobWithGuard(queue, {
        webPageId,
        url: validated.url,
        options: jobOptions,
      });
      const jobId = enqueueResult.jobId;

      // Always-on structured log: `outcome` surfaces enqueued_new /
      // reused_active / enqueued_retry / limbo_forced / enqueued_fail_open for
      // ops triage (5-variant union post PR-D-7 Phase 2 Wave 2 Option Z-a).
      // Keep payload PII-safe via 8-char truncation.
      logger.info("[page.analyze] Enqueue outcome", {
        outcome: enqueueResult.outcome,
        jobId: enqueueResult.jobId,
        collision: enqueueResult.collision,
        webPageId: webPageId.slice(0, 8) + "...",
      });

      if (isDevelopment()) {
        logger.info("[page.analyze] Job queued successfully", {
          jobId: enqueueResult.jobId,
          outcome: enqueueResult.outcome,
          webPageId,
          url: validated.url,
        });
      }

      // 非同期レスポンスを返す
      const autoAsyncNote = autoAsyncEnabled
        ? " (Auto-enabled: Vision analysis requires async mode to avoid MCP timeout)"
        : "";
      const asyncResponse: PageAnalyzeAsyncOutput = {
        async: true,
        jobId,
        webPageId,
        status: "queued",
        message: `Job queued successfully.${autoAsyncNote} Use page.getJobStatus(job_id="${jobId}") to check progress.`,
        polling: {
          intervalSeconds: 10, // Vision処理は長時間かかるため10秒間隔を推奨
          retentionHours: 24,
          howToCheck: `Call page.getJobStatus with job_id="${jobId}" to check job status and retrieve results.`,
        },
      };

      return asyncResponse as unknown as PageAnalyzeOutput;
    } finally {
      await closeQueue(queue);
    }
  }

  // =====================================================
  // MCP 570秒ハードタイムアウトガード（v0.1.0）
  // =====================================================
  // MCP プロトコルの600秒タイムアウトを超えないよう、570秒（30秒安全マージン）で
  // sync mode全体をハードタイムアウトで保護する。
  // CPU Vision延長やフェーズ個別タイムアウトが膨らんでも、このガードで確実に打ち切る。
  // fetchExternalCss: true で多数の外部リソースを取得する際のハング防止が主目的。
  const OVERALL_HARD_TIMEOUT_MS = 570000; // 570秒 = MCP 600秒 - 30秒安全マージン

  // タイマーIDを保持してクリーンアップ可能にする
  let hardTimeoutId: ReturnType<typeof setTimeout> | undefined;

  const syncProcessingResult = await Promise.race([
    executeSyncProcessing(
      validated,
      normalizedUrl,
      overallStartTime,
      {
        getService: () => serviceFactoryDI.get()?.() ?? {},
        getPrismaClient,
      },
      progressContext,
      progressService
    ),
    new Promise<PageAnalyzeOutput>((_, reject) => {
      hardTimeoutId = setTimeout(() => {
        reject(new PhaseTimeoutError("page.analyze-overall", OVERALL_HARD_TIMEOUT_MS));
      }, OVERALL_HARD_TIMEOUT_MS);
    }),
  ])
    .catch((error): PageAnalyzeOutput => {
      const isTimeout = error instanceof PhaseTimeoutError;
      const elapsedMs = Date.now() - overallStartTime;

      logger.error("[page.analyze] Overall hard timeout triggered", {
        timeoutMs: OVERALL_HARD_TIMEOUT_MS,
        elapsedMs,
        isTimeout,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        error: {
          code: PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR,
          message: `page.analyze exceeded MCP hard timeout limit (${Math.round(elapsedMs / 1000)}s / ${OVERALL_HARD_TIMEOUT_MS / 1000}s). Consider using fetchExternalCss: false or reducing analysis scope.`,
        },
      };
    })
    .finally(() => {
      // Promise.race で executeSyncProcessing が先に完了した場合、タイマーをクリーンアップ
      if (hardTimeoutId) {
        clearTimeout(hardTimeoutId);
      }
    });

  return syncProcessingResult;
}

// =====================================================
// ツール定義
// =====================================================

export const pageAnalyzeToolDefinition = {
  name: "page.analyze",
  description:
    "Analyze a web page URL with layout detection, motion pattern extraction, and quality evaluation. Executes layout.ingest, motion.detect, and quality.evaluate in parallel and returns unified results. Supports MCP streaming progress via _meta.progressToken for real-time phase notifications.",
  annotations: {
    title: "Page Analyze",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object" as const,
    required: ["url"],
    properties: {
      url: {
        type: "string",
        format: "uri",
        description: "Target URL to analyze (required)",
      },
      sourceType: {
        type: "string",
        enum: ["award_gallery", "user_provided"],
        default: "user_provided",
        description: "Source type: award_gallery or user_provided (default)",
      },
      usageScope: {
        type: "string",
        enum: ["inspiration_only", "owned_asset"],
        default: "inspiration_only",
        description: "Usage scope: inspiration_only (default) or owned_asset",
      },
      features: {
        type: "object",
        description: "Feature flags for analysis (default: all true)",
        properties: {
          layout: {
            type: "boolean",
            default: true,
            description: "Enable layout analysis (default: true)",
          },
          motion: {
            type: "boolean",
            default: true,
            description: "Enable motion detection (default: true)",
          },
          quality: {
            type: "boolean",
            default: true,
            description: "Enable quality evaluation (default: true)",
          },
        },
      },
      layoutOptions: {
        type: "object",
        description: "Layout analysis options",
        properties: {
          fullPage: {
            type: "boolean",
            default: true,
            description: "Full page screenshot (default: true)",
          },
          viewport: {
            type: "object",
            properties: {
              width: { type: "number", minimum: 320, maximum: 4096, default: 1440 },
              height: { type: "number", minimum: 240, maximum: 16384, default: 900 },
            },
          },
          // MCP-RESP-03: snake_case正式形式（新規オプション推奨形式）
          include_html: {
            type: "boolean",
            default: false,
            description: "Include HTML in response (default: false) - snake_case正式形式",
          },
          include_screenshot: {
            type: "boolean",
            default: false,
            description: "Include screenshot in response (default: false) - snake_case正式形式",
          },
          // レガシー互換: camelCaseは後方互換として維持
          includeHtml: {
            type: "boolean",
            default: false,
            description:
              "Include HTML in response (default: false) - レガシー互換、include_html推奨",
          },
          includeScreenshot: {
            type: "boolean",
            default: false,
            description:
              "Include screenshot in response (default: false) - レガシー互換、include_screenshot推奨",
          },
          saveToDb: {
            type: "boolean",
            default: true,
            description: "Save to database (default: true)",
          },
          autoAnalyze: {
            type: "boolean",
            default: true,
            description: "Auto analyze sections and generate embeddings (default: true)",
          },
          fetchExternalCss: {
            type: "boolean",
            default: true,
            description: "Fetch external CSS files for layout analysis (default: true)",
          },
          useVision: {
            type: "boolean",
            default: true,
            description:
              "Use Vision API (Ollama + llama3.2-vision) to analyze screenshot for section detection. Delegates to layout.inspect screenshot mode. (default: true)",
          },
          // PR-L2 (CO-ASYNC-03): nested coercion parity — string→scalar coercion
          // for the following nested scalars (constraints match input.schemas.ts).
          perSectionVision: {
            type: "boolean",
            default: true,
            description:
              "Enable per-section Vision analysis for more accurate semantic search. Requires useVision=true. Increases processing time. (default: true) / セクション単位のVision解析を有効化（処理時間増加、デフォルト: true）",
          },
          visionBatchSize: {
            type: "number",
            minimum: 1,
            maximum: 10,
            default: 5,
            description:
              "Maximum concurrent Vision API calls when perSectionVision is enabled (default: 5) / perSectionVision有効時の最大並列Vision API呼び出し数（デフォルト: 5）",
          },
          scrollVision: {
            type: "boolean",
            default: true,
            description:
              "Scroll-position Smart Capture + Vision analysis at section boundaries (async mode only, default: true) / スクロール位置スマートキャプチャ + Vision解析（asyncモードのみ、デフォルト: true）",
          },
          scrollVisionMaxCaptures: {
            type: "number",
            minimum: 2,
            maximum: 20,
            default: 10,
            description:
              "Maximum number of scroll positions to capture (default: 10) / キャプチャするスクロール位置の最大数（デフォルト: 10）",
          },
        },
      },
      motionOptions: {
        type: "object",
        description: "Motion detection options",
        properties: {
          fetchExternalCss: {
            type: "boolean",
            default: false,
            description: "Fetch external CSS files (default: false)",
          },
          minDuration: {
            type: "number",
            minimum: 0,
            default: 0,
            description: "Minimum animation duration in ms (default: 0)",
          },
          maxPatterns: {
            type: "number",
            minimum: 1,
            maximum: 4000,
            default: 500,
            description: "Maximum patterns to detect (default: 500)",
          },
          includeWarnings: {
            type: "boolean",
            default: true,
            description: "Include warnings in response (default: true)",
          },
          saveToDb: {
            type: "boolean",
            default: true,
            description: "Save motion patterns to database (default: true)",
          },
          // Video Mode Options (Phase 5)
          enable_frame_capture: {
            type: "boolean",
            default: true,
            description: "Enable frame capture for scroll animation analysis (default: true)",
          },
          frame_capture_options: {
            type: "object",
            description: "Frame capture configuration",
            properties: {
              frame_rate: {
                type: "number",
                minimum: 1,
                maximum: 120,
                default: 30,
                description: "Frame rate (default: 30fps)",
              },
              frame_interval_ms: {
                type: "number",
                minimum: 1,
                maximum: 1000,
                default: 33,
                description: "Frame interval in milliseconds (default: 33ms = 30fps)",
              },
              scroll_speed_px_per_sec: {
                type: "number",
                minimum: 1,
                description: "Scroll speed in pixels per second (optional)",
              },
              scroll_px_per_frame: {
                type: "number",
                minimum: 0.01,
                default: 15,
                description: "Scroll pixels per frame (default: 15px)",
              },
              output_format: {
                type: "string",
                enum: ["png", "jpeg"],
                default: "png",
                description: "Output image format (default: png)",
              },
              output_dir: {
                type: "string",
                default: "/tmp/reftrix-frames/",
                description: "Output directory for frames (default: /tmp/reftrix-frames/)",
              },
              filename_pattern: {
                type: "string",
                default: "frame-{0000}.png",
                description:
                  "Filename pattern with frame number placeholder (default: frame-{0000}.png)",
              },
              page_height_px: {
                type: "number",
                minimum: 100,
                maximum: 100000,
                description: "Manual page height in pixels (optional, auto-detected if omitted)",
              },
              scroll_duration_sec: {
                type: "number",
                minimum: 0.1,
                maximum: 300,
                description: "Scroll duration in seconds (optional)",
              },
            },
          },
          analyze_frames: {
            type: "boolean",
            default: true,
            description: "Enable frame image analysis with pixelmatch (default: true)",
          },
          frame_analysis_options: {
            type: "object",
            description: "Frame analysis configuration",
            properties: {
              frame_dir: {
                type: "string",
                description:
                  "Frame image directory (optional, uses frame_capture_options.output_dir if omitted)",
              },
              sample_interval: {
                type: "number",
                minimum: 1,
                maximum: 100,
                default: 1,
                description: "Analyze every Nth frame (default: 1 = all frames)",
              },
              diff_threshold: {
                type: "number",
                minimum: 0,
                maximum: 1,
                default: 0.01,
                description: "Minimum diff percentage to consider as change (default: 0.01 = 1%)",
              },
              cls_threshold: {
                type: "number",
                minimum: 0,
                maximum: 1,
                default: 0.1,
                description: "CLS (Cumulative Layout Shift) warning threshold (default: 0.1)",
              },
              motion_threshold: {
                type: "number",
                minimum: 1,
                maximum: 500,
                default: 5,
                description: "Minimum pixels to detect motion vector (default: 5)",
              },
              output_diff_images: {
                type: "boolean",
                default: false,
                description: "Save diff images to output_dir (default: false)",
              },
              parallel: {
                type: "boolean",
                default: true,
                description: "Process frames in parallel (default: true)",
              },
            },
          },
          // JS Animation Options (v0.1.0)
          detect_js_animations: {
            type: "boolean",
            default: false,
            description:
              "Enable JavaScript animation detection via CDP + Web Animations API + library detection (default: false, requires Playwright)",
          },
          js_animation_options: {
            type: "object",
            description: "JS animation detection configuration",
            properties: {
              enableCDP: {
                type: "boolean",
                default: true,
                description: "Enable Chrome DevTools Protocol animation detection (default: true)",
              },
              enableWebAnimations: {
                type: "boolean",
                default: true,
                description: "Enable Web Animations API detection (default: true)",
              },
              enableLibraryDetection: {
                type: "boolean",
                default: true,
                description:
                  "Enable library detection (GSAP, Framer Motion, anime.js, Three.js, Lottie) (default: true)",
              },
              waitTime: {
                type: "number",
                minimum: 0,
                maximum: 10000,
                default: 2000,
                description:
                  "Wait time in ms after page load before detecting animations (default: 2000)",
              },
            },
          },
          // v0.1.0: Motion検出タイムアウト（asyncモードでは長時間検出可能）
          timeout: {
            type: "number",
            minimum: 30000,
            maximum: 600000,
            default: 300000,
            description:
              "Motion detection timeout in milliseconds. MCP Protocol has a 60-second tool call limit. In async mode (page.analyze with async=true), this limit does not apply, allowing longer detection times for heavy WebGL/Three.js sites. (default: 300000 = 5 minutes, max: 600000 = 10 minutes)",
          },
          // ===== PR-L2 (CO-ASYNC-03): nested coercion parity =====
          // detect_webgl_animations + video_options / runtime_options /
          // webgl_animation_options nested scalars. Constraints match
          // input.schemas.ts (motionOptionsSchema). NOTE: frame_analysis_options
          // and js_animation_options are ALREADY fully declared above and are
          // intentionally left untouched.
          detect_webgl_animations: {
            type: "boolean",
            default: true,
            description:
              "Enable WebGL/Canvas animation detection (Three.js etc.) via frame-based analysis (requires Playwright, default: true) / WebGL/Canvasアニメーション検出（Three.js等、Playwright必要、デフォルト: true）",
          },
          video_options: {
            type: "object",
            description:
              "Video recording + frame analysis options (active when detection_mode='video') / 動画録画+フレーム解析オプション（detection_mode='video'時のみ有効）",
            properties: {
              timeout: {
                type: "number",
                minimum: 1000,
                maximum: 120000,
                default: 30000,
                description:
                  "Page load timeout in ms (default: 30000) / ページ読み込みタイムアウト",
              },
              record_duration: {
                type: "number",
                minimum: 1000,
                maximum: 60000,
                default: 10000,
                description: "Recording duration in ms (default: 10000) / 録画時間",
              },
              viewport: {
                type: "object",
                description: "Viewport size / ビューポートサイズ",
                properties: {
                  width: { type: "number", minimum: 320, maximum: 4096 },
                  height: { type: "number", minimum: 240, maximum: 4096 },
                },
              },
              scroll_page: {
                type: "boolean",
                default: true,
                description: "Perform scroll operations (default: true) / スクロール操作を行うか",
              },
              move_mouse: {
                type: "boolean",
                default: true,
                description:
                  "Perform mouse-move operations (default: true) / マウス移動操作を行うか",
              },
              wait_until: {
                type: "string",
                enum: ["load", "domcontentloaded", "networkidle"],
                default: "domcontentloaded",
                description:
                  "Page load completion strategy (default: domcontentloaded) / ページロード完了待機戦略",
              },
              frame_analysis: {
                type: "object",
                description: "Frame analysis options / フレーム解析オプション",
                properties: {
                  fps: {
                    type: "number",
                    minimum: 1,
                    maximum: 30,
                    default: 15,
                    description: "Frame rate (1-30fps, default: 15) / フレームレート",
                  },
                  change_threshold: {
                    type: "number",
                    minimum: 0,
                    maximum: 1,
                    default: 0.005,
                    description: "Change detection threshold (0-1, default: 0.005) / 変化検出閾値",
                  },
                  min_motion_duration_ms: {
                    type: "number",
                    minimum: 0,
                    maximum: 10000,
                    default: 50,
                    description:
                      "Minimum motion duration in ms (default: 50) / 最小モーション継続時間",
                  },
                  gap_tolerance_ms: {
                    type: "number",
                    minimum: 0,
                    maximum: 1000,
                    default: 50,
                    description: "Gap tolerance in ms (default: 50) / ギャップ許容時間",
                  },
                },
              },
            },
          },
          runtime_options: {
            type: "object",
            description:
              "Runtime detection options (active when detection_mode='runtime' or 'hybrid') / ランタイム検出オプション（detection_mode='runtime'または'hybrid'時のみ有効）",
            properties: {
              wait_for_animations: {
                type: "number",
                minimum: 0,
                maximum: 30000,
                default: 5000,
                description: "Animation wait time in ms (default: 5000) / アニメーション待機時間",
              },
            },
          },
          webgl_animation_options: {
            type: "object",
            description:
              "WebGL animation detection options (active when detect_webgl_animations=true) / WebGLアニメーション検出オプション（detect_webgl_animations=true時のみ有効）",
            properties: {
              sample_frames: {
                type: "number",
                minimum: 5,
                maximum: 100,
                default: 50,
                description: "Number of frames to sample (default: 50) / サンプリングフレーム数",
              },
              sample_interval_ms: {
                type: "number",
                minimum: 50,
                maximum: 500,
                default: 100,
                description: "Frame interval in ms (default: 100) / フレーム間隔",
              },
              change_threshold: {
                type: "number",
                minimum: 0.001,
                maximum: 0.5,
                default: 0.005,
                description:
                  "Change detection threshold (0.001-0.5, default: 0.005) / 変化検出閾値",
              },
              timeout_ms: {
                type: "number",
                minimum: 5000,
                maximum: 180000,
                default: 120000,
                description: "Detection timeout in ms (default: 120000) / 検出タイムアウト",
              },
            },
          },
        },
      },
      qualityOptions: {
        type: "object",
        description: "Quality evaluation options",
        properties: {
          weights: {
            type: "object",
            properties: {
              originality: { type: "number", minimum: 0, maximum: 1, default: 0.35 },
              craftsmanship: { type: "number", minimum: 0, maximum: 1, default: 0.4 },
              contextuality: { type: "number", minimum: 0, maximum: 1, default: 0.25 },
            },
          },
          targetIndustry: {
            type: "string",
            maxLength: 100,
            description: "Target industry for contextual evaluation",
          },
          targetAudience: {
            type: "string",
            maxLength: 100,
            description: "Target audience for contextual evaluation",
          },
          strict: {
            type: "boolean",
            default: false,
            description: "Strict mode for AI cliche detection (default: false)",
          },
          includeRecommendations: {
            type: "boolean",
            default: true,
            description: "Include recommendations in response (default: true)",
          },
        },
      },
      summary: {
        type: "boolean",
        default: true,
        description: "Return summary response (default: true). Set to false for full details.",
      },
      async: {
        type: "boolean",
        description:
          "Async mode (default: auto). true: enqueue a BullMQ job and return a jobId immediately (poll with page.getJobStatus). false: synchronous processing. When omitted, auto-enabled if Vision is on and Redis is available (Vision LLM exceeds the MCP timeout in CPU mode). Requires Redis when true.",
      },
      timeout: {
        type: "number",
        minimum: 5000,
        maximum: 600000,
        default: 600000,
        description: "Overall timeout in ms (default: 600000)",
      },
      waitUntil: {
        type: "string",
        enum: ["load", "domcontentloaded", "networkidle"],
        default: "networkidle",
        description: "Page load completion criteria (default: networkidle)",
      },
      timeout_strategy: {
        type: "string",
        enum: ["strict", "progressive"],
        default: "progressive",
        description:
          "Timeout strategy. strict: fail completely on timeout. progressive: return partial results on timeout (default).",
      },
      partial_results: {
        type: "boolean",
        default: true,
        description:
          "Allow partial results on timeout (default: true). When true, returns results from completed phases on timeout.",
      },
      layoutTimeout: {
        type: "number",
        minimum: 5000,
        maximum: 300000,
        default: 120000,
        description: "Per-phase timeout for layout analysis in ms (default: 120000).",
      },
      motionTimeout: {
        type: "number",
        minimum: 5000,
        maximum: 300000,
        default: 300000,
        description: "Per-phase timeout for motion detection in ms (default: 300000).",
      },
      qualityTimeout: {
        type: "number",
        minimum: 5000,
        maximum: 60000,
        default: 60000,
        description: "Per-phase timeout for quality evaluation in ms (default: 60000).",
      },
      auto_retry: {
        type: "boolean",
        default: true,
        description:
          "Enable staged auto-retry on HTML fetch failure (default: true). Retries with progressively longer timeouts and relaxed waitUntil.",
      },
      max_retries: {
        type: "number",
        minimum: 1,
        maximum: 3,
        default: 3,
        description: "Maximum retry attempts when auto_retry is true (default: 3).",
      },
      layout_first: {
        type: "string",
        enum: ["auto", "always", "never"],
        default: "auto",
        description:
          "Layout-first mode for WebGL/Three.js sites (default: auto). auto: prioritise layout when WebGL is detected. always: always prioritise layout. never: legacy parallel processing.",
      },
      respect_robots_txt: {
        type: "boolean",
        description: "Respect robots.txt (RFC 9309). Set to false to ignore.",
      },
      auto_timeout: {
        type: "boolean",
        default: false,
        description:
          "Enable Pre-flight Probe for dynamic timeout calculation (v0.1.0). Analyzes page complexity (WebGL, SPA, heavy frameworks) before analysis and calculates optimal timeout. Results are included in preflightProbe response field.",
      },
      narrativeOptions: {
        type: "object",
        description:
          "Narrative analysis options. Analyzes the page's worldview/atmosphere and layout structure. enabled=true to activate.",
        properties: {
          enabled: {
            type: "boolean",
            default: true,
            description: "Enable narrative analysis (default: true)",
          },
          saveToDb: {
            type: "boolean",
            default: true,
            description: "Save narrative analysis results to DB (default: true)",
          },
          includeVision: {
            type: "boolean",
            default: true,
            description: "Use Vision LLM for higher-precision narrative analysis (default: true)",
          },
          visionTimeoutMs: {
            type: "number",
            minimum: 30000,
            maximum: 600000,
            default: 300000,
            description: "Narrative Vision analysis timeout in ms (default: 300000).",
          },
          generateEmbedding: {
            type: "boolean",
            default: true,
            description: "Generate embeddings as part of narrative analysis (default: true)",
          },
        },
      },
      visionOptions: {
        type: "object",
        description:
          "Vision CPU completion-guarantee options (Phase 3). Controls Vision model (Ollama llama3.2-vision) inference timeout, image optimisation, CPU forcing, and graceful degradation.",
        properties: {
          visionTimeoutMs: {
            type: "number",
            minimum: 1000,
            maximum: 1200000,
            description:
              "Vision analysis timeout in ms. Auto-calculated from hardware detection when omitted.",
          },
          visionImageMaxSize: {
            type: "number",
            minimum: 1024,
            maximum: 10000000,
            description:
              "Maximum image size in bytes passed to Vision analysis. Larger images are auto-compressed.",
          },
          visionForceCpu: {
            type: "boolean",
            default: false,
            description: "Force CPU mode even when a GPU is available (default: false).",
          },
          visionEnableProgress: {
            type: "boolean",
            default: false,
            description:
              "Enable progress reporting during long Vision processing (default: false).",
          },
          // PR-L2 (CO-ASYNC-03): nested coercion parity.
          visionFallbackToHtmlOnly: {
            type: "boolean",
            default: true,
            description:
              "Continue with HTML-only analysis when Vision times out / fails (Graceful Degradation, default: true) / Vision失敗時にHTML解析のみで続行（Graceful Degradation、デフォルト: true）",
          },
        },
      },
      responsiveOptions: {
        type: "object",
        description:
          "Responsive layout analysis options. Captures layouts at multiple viewport sizes (desktop/tablet/mobile) and detects differences in typography, spacing, navigation, and layout structure.",
        properties: {
          enabled: {
            type: "boolean",
            default: true,
            description: "Enable responsive analysis (default: true)",
          },
          viewports: {
            type: "array",
            description:
              "Custom viewport configurations. Default: desktop (1920x1080), tablet (768x1024), mobile (375x667)",
            items: {
              type: "object",
              required: ["name", "width", "height"],
              properties: {
                name: {
                  type: "string",
                  description: "Viewport name (e.g., desktop, tablet, mobile)",
                },
                width: {
                  type: "number",
                  minimum: 320,
                  maximum: 4096,
                  description: "Width in pixels",
                },
                height: {
                  type: "number",
                  minimum: 240,
                  maximum: 16384,
                  description: "Height in pixels",
                },
              },
            },
          },
          include_screenshots: {
            type: "boolean",
            default: false,
            description:
              "Include screenshots for each viewport in response (default: false, DB-first workflow)",
          },
          include_diff_images: {
            type: "boolean",
            default: false,
            description: "Include diff images in viewport comparison results (default: false)",
          },
          diff_threshold: {
            type: "number",
            minimum: 0,
            maximum: 1,
            default: 0.1,
            description: "Pixel diff threshold for viewport comparison (0-1, default: 0.1)",
          },
          save_to_db: {
            type: "boolean",
            default: true,
            description: "Save responsive analysis results to DB (default: true)",
          },
          detect_navigation: {
            type: "boolean",
            default: true,
            description:
              "Detect navigation pattern changes (horizontal-menu to hamburger-menu, etc.) (default: true)",
          },
          detect_visibility: {
            type: "boolean",
            default: true,
            description: "Detect element visibility changes between viewports (default: true)",
          },
          detect_layout: {
            type: "boolean",
            default: true,
            description:
              "Detect layout structure changes (grid columns, flex direction, etc.) (default: true)",
          },
          // PR-L2 (CO-ASYNC-03): advertised/Zod parity completion (enum, not coerced).
          breakpoint_resolution: {
            type: "string",
            enum: ["range", "precise"],
            default: "range",
            description:
              "Breakpoint resolution: 'range' (CSS media query + VP diff estimate) or 'precise' (binary search, ±8px, 3-5x slower). (default: range) / ブレークポイント解像度（preciseは処理時間3-5倍）",
          },
        },
      },
      // Phase 7.5: Post-Analysis Gate (v0.3.0, opt-in)
      auto_snapshot: {
        type: "boolean",
        default: false,
        description:
          "Auto-save design snapshot after analysis (default: false). Creates a point-in-time record for design.track_changes comparison.",
      },
      accessibilityOptions: {
        type: "object",
        description:
          "Accessibility audit options (v0.3.0 Phase 7.5a, opt-in). WCAG 2.1 AA compliance audit via axe-core. Timeout: 10s. Disabled by default.",
        properties: {
          enabled: {
            type: "boolean",
            default: false,
            description: "Enable accessibility audit (default: false)",
          },
          level: {
            type: "string",
            enum: ["A", "AA", "AAA"],
            default: "AA",
            description: "WCAG conformance level (default: AA)",
          },
          include_contrast: {
            type: "boolean",
            default: true,
            description: "Include OKLCH contrast ratio check (default: true)",
          },
          save_to_db: {
            type: "boolean",
            default: true,
            description: "Save audit results to DB (default: true)",
          },
        },
      },
      performanceOptions: {
        type: "object",
        description:
          "Performance evaluation options (v0.3.0 Phase 7.5b, opt-in). Core Web Vitals (LCP/FID/CLS/INP/TTFB) measurement. Timeout: 40s. Disabled by default.",
        properties: {
          enabled: {
            type: "boolean",
            default: false,
            description: "Enable performance evaluation (default: false)",
          },
          include_screenshots: {
            type: "boolean",
            default: false,
            description: "Include screenshots in response (default: false)",
          },
          budget: {
            type: "object",
            description:
              "Custom performance budget (default: Google recommended LCP<2.5s, CLS<0.1, FID<100ms, TTFB<800ms, INP<200ms)",
          },
          save_to_db: {
            type: "boolean",
            default: true,
            description: "Save evaluation results to DB (default: true)",
          },
        },
      },
    },
  },
};
