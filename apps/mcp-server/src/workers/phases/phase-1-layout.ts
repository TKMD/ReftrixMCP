// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 1: Layout Analysis + Phase 1.1: Part Extraction
 *
 * Performs layout analysis via Ollama Vision, saves BackgroundDesigns and
 * SectionPatterns to DB (with CSS distribution and postProcessSections),
 * then extracts UI parts from each section.
 *
 * Extracted from page-analyze-worker.ts (TDA-C1) to enable phase-level modularity.
 *
 * @module workers/phases/phase-1-layout
 */

import fs from "node:fs";
import sharp from "sharp";
import { logger, isDevelopment } from "../../utils/logger";
import type { LayoutServiceResult } from "../../tools/page/handlers/types";
import type {
  LayoutSection,
  SectionPatternPrismaClient,
  SaveResult,
} from "../../services/worker-db-save.service";
import type {
  BackgroundDesignForSave,
  BackgroundDesignPrismaClient,
  SaveBackgroundDesignsResult,
} from "../../services/background/background-design-db.service";
import type {
  PostProcessableSection,
  PostProcessResult,
} from "../../services/page/section-postprocessor.service";
import {
  DEFAULT_PART_EXTRACTION_CONFIG,
  type PartExtractionConfig,
} from "../../services/part/types";
import type { PartSaveResult } from "../../services/part/part-db.service";

import { type PipelineState, type PhaseContext, PHASE_PROGRESS, extendJobLock } from "./types";

// ============================================================================
// Types
// ============================================================================

/**
 * Dependencies injected into the layout phase.
 *
 * All service functions that Phase 1 / 1.1 invoke are passed via this
 * interface so that the module has no hard dependency on singletons.
 */
export interface LayoutPhaseDeps {
  /** Layout analysis service (defaultAnalyzeLayout) */
  defaultAnalyzeLayout: (
    html: string,
    options?: Record<string, unknown>,
    screenshot?: { base64: string; mimeType: string },
    computedStyles?: undefined,
    baseUrl?: string,
    preExtractedCssUrls?: undefined,
    visionOptions?: undefined,
    progressContext?: undefined,
    webPageId?: string
  ) => Promise<LayoutServiceResult>;

  /** Save background designs to DB */
  saveBackgroundDesigns: (
    prisma: BackgroundDesignPrismaClient,
    webPageId: string,
    backgrounds: BackgroundDesignForSave[]
  ) => Promise<SaveBackgroundDesignsResult>;

  /** Save section patterns to DB */
  saveSectionPatterns: (
    prisma: SectionPatternPrismaClient,
    webPageId: string,
    sections: LayoutSection[]
  ) => Promise<SaveResult>;

  /** Section Merge/Split Post-Processor */
  postProcessSections: (sections: PostProcessableSection[]) => PostProcessResult;

  /** Extract parts from a single section HTML */
  extractPartsFromSection: (params: {
    sectionHtml: string;
    sectionIndex: number;
    config: PartExtractionConfig;
    computedStylesMap: Map<string, Record<string, string>>;
    sectionBoundingBox: { x: number; y: number; width: number; height: number };
    fullScreenshot?: Buffer;
    sourceUrl?: string | null;
  }) => Promise<{ parts: Array<{ [key: string]: unknown }> }>;

  /** Save extracted parts to DB */
  saveExtractedParts: (
    prisma: unknown,
    webPageId: string,
    sectionPatternId: string,
    parts: Array<{ [key: string]: unknown }>,
    sourceUrl: string | null
  ) => Promise<PartSaveResult>;

  /**
   * Prisma client instance.
   * 複数の Prisma サブタイプ（BackgroundDesignPrismaClient, SectionPatternPrismaClient,
   * PrismaClient）として使用されるため、呼び出し側で `as unknown as SpecificType` でキャストする。
   */
  prisma: unknown;
}

// ============================================================================
// Phase 1 + 1.1 Entry Point
// ============================================================================

/**
 * Execute Phase 1 (Layout Analysis) and Phase 1.1 (Part Extraction).
 *
 * Mutates `state` with layout results, section save results, background save
 * results, and part extraction results. Also updates `state.layoutResultForNarrative`
 * for downstream phases (Narrative, Embedding).
 *
 * Graceful Degradation: failures in background save, section save, or part
 * extraction are logged but do **not** abort the pipeline.
 */
export async function processLayoutPhase(
  state: PipelineState,
  ctx: PhaseContext,
  deps: LayoutPhaseDeps
): Promise<void> {
  const { options, url, statusTracker, job, effectiveToken, effectiveLockDuration } = ctx;
  const { actualWebPageId, completedPhases, failedPhases } = state;
  const html = state.html;

  // Ensure results object is initialised (caller always provides {})
  if (!state.results) {
    state.results = {};
  }
  const results = state.results;

  // =====================================================
  // Phase 1: Layout Analysis
  // =====================================================
  if (options.features?.layout !== false) {
    statusTracker.startPhase("layout");
    await job.updateProgress(PHASE_PROGRESS.LAYOUT_START);
    await job.log("[Phase 1] Layout analysis started");

    try {
      if (isDevelopment()) {
        logger.debug("[PageAnalyzeWorker] Starting layout analysis");
      }

      const layoutResult = await deps.defaultAnalyzeLayout(
        html!,
        {
          useVision: options.layoutOptions?.useVision ?? true,
          fullPage: options.layoutOptions?.fullPage ?? true,
          // MCP-RESP-03: 両形式をサポート（snake_case優先）
          include_html: false,
          includeHtml: false,
          include_screenshot: false,
          includeScreenshot: false,
          fetchExternalCss: true,
          saveToDb: options.layoutOptions?.saveToDb ?? true,
          autoAnalyze: options.layoutOptions?.autoAnalyze ?? true,
          perSectionVision: false,
          visionBatchSize: 3,
          scrollVision: options.layoutOptions?.scrollVision ?? true,
          scrollVisionMaxCaptures: options.layoutOptions?.scrollVisionMaxCaptures ?? 10,
          viewport: options.layoutOptions?.viewport,
        },
        state.screenshotBase64
          ? {
              base64: state.screenshotBase64,
              mimeType: "image/png",
            }
          : undefined,
        undefined, // computedStyles
        url, // baseUrl
        undefined, // preExtractedCssUrls
        undefined, // visionOptions
        undefined, // progressContext
        actualWebPageId // v0.1.0: actualWebPageId（upsertで取得した実際のDB ID）
      );

      statusTracker.completePhase("layout");
      completedPhases.push("layout");
      state.layoutResultForNarrative = layoutResult; // Narrative分析用に保持
      results.layout = {
        sectionsDetected: layoutResult.sectionCount ?? 0,
        visionUsed: options.layoutOptions?.useVision ?? true,
      };

      if (isDevelopment()) {
        logger.debug("[PageAnalyzeWorker] Layout analysis completed", {
          sectionsDetected: results.layout.sectionsDetected,
        });
      }

      // BackgroundDesign DB保存（layoutResultに含まれる場合）
      if (
        actualWebPageId &&
        layoutResult.backgroundDesigns &&
        layoutResult.backgroundDesigns.length > 0
      ) {
        try {
          const backgroundDesignsForSave: BackgroundDesignForSave[] =
            layoutResult.backgroundDesigns.map((bg) => ({
              name: bg.name,
              designType: bg.designType,
              cssValue: bg.cssValue,
              selector: bg.selector,
              positionIndex: bg.positionIndex,
              colorInfo: bg.colorInfo as unknown as Record<string, unknown>,
              gradientInfo: bg.gradientInfo as unknown as Record<string, unknown> | undefined,
              visualProperties: bg.visualProperties as unknown as Record<string, unknown>,
              animationInfo: bg.animationInfo as unknown as Record<string, unknown> | undefined,
              cssImplementation: bg.cssImplementation,
              performance: bg.performance as unknown as Record<string, unknown>,
              confidence: bg.confidence,
              sourceUrl: url,
              usageScope: "inspiration_only",
            }));

          state.bgSaveResult = await deps.saveBackgroundDesigns(
            deps.prisma as unknown as BackgroundDesignPrismaClient,
            actualWebPageId,
            backgroundDesignsForSave
          );

          if (isDevelopment()) {
            logger.info("[PageAnalyzeWorker] BackgroundDesigns saved", {
              count: state.bgSaveResult.count,
              idMappingSize: state.bgSaveResult.idMapping.size,
              webPageId: actualWebPageId,
            });
          }
        } catch (bgError) {
          // Graceful Degradation: BackgroundDesign保存失敗はジョブを中断しない
          logger.warn("[PageAnalyzeWorker] BackgroundDesign save failed", {
            error: bgError instanceof Error ? bgError.message : String(bgError),
          });
        }
      }

      // SectionPattern DB保存（layoutResultに含まれる場合）
      if (actualWebPageId && layoutResult.sections && layoutResult.sections.length > 0) {
        try {
          // ページレベルCSSを各セクションに配布（sync pathのanalyze.tool.tsと同じアプローチ）
          // Distribute page-level CSS to each section (same approach as sync path in analyze.tool.ts)
          const pageCssSnippet = layoutResult.cssSnippet;
          const pageExternalCssContent = layoutResult.externalCssContent;
          const pageExternalCssMeta = layoutResult.externalCssMeta;
          const pageCssFramework = layoutResult.cssFramework;

          const sectionsWithCss: LayoutSection[] = layoutResult.sections.map((section) => {
            const enriched: LayoutSection = { ...section };

            // ページ全体のCSSスニペットを各セクションに設定
            // Set page-level CSS snippet to each section
            if (pageCssSnippet !== undefined && pageCssSnippet.length > 0) {
              enriched.cssSnippet = pageCssSnippet;
            }

            if (pageExternalCssContent !== undefined && pageExternalCssContent.length > 0) {
              enriched.externalCssContent = pageExternalCssContent;
            }

            if (pageExternalCssMeta !== undefined) {
              enriched.externalCssMeta = pageExternalCssMeta;
            }

            // ページ全体のCSSフレームワーク検出結果を各セクションに設定
            // Set page-level CSS framework detection result to each section
            if (pageCssFramework !== undefined) {
              enriched.cssFramework = pageCssFramework.framework;
              enriched.cssFrameworkMeta = {
                confidence: pageCssFramework.confidence,
                evidence: pageCssFramework.evidence,
              };
            }

            return enriched;
          });

          if (isDevelopment()) {
            logger.debug("[PageAnalyzeWorker] CSS distributed to sections", {
              hasCssSnippet: !!pageCssSnippet,
              cssSnippetLength: pageCssSnippet?.length ?? 0,
              hasExternalCssContent: !!pageExternalCssContent,
              cssFramework: pageCssFramework?.framework,
              sectionCount: sectionsWithCss.length,
            });
          }

          // Section Merge/Split Post-Processor（過剰分割修正 + 巨大セクション再分割）
          // Section Merge/Split Post-Processor (fix over-segmentation + split oversized sections)
          const postProcessResult = deps.postProcessSections(sectionsWithCss);
          const postProcessedSections = postProcessResult.sections as LayoutSection[];

          if (
            postProcessResult.stats.mergedGroups > 0 ||
            postProcessResult.stats.absorbedCount > 0 ||
            postProcessResult.stats.splitCount > 0
          ) {
            logger.info(
              "[PageAnalyzeWorker] Section post-processing applied",
              postProcessResult.stats
            );
          }

          state.sectionSaveResult = await deps.saveSectionPatterns(
            deps.prisma as unknown as SectionPatternPrismaClient,
            actualWebPageId,
            postProcessedSections
          );

          // postProcessSectionsの結果をembedding生成用のlayoutResultに常に反映
          // Always update layoutResult sections with post-processed sections for embedding generation
          // Phase 5のtext embedding生成がpostProcessed後のセクション（分割/マージ含む）を使用するため
          // 注: セクション数が変わらなくてもIDが変わるケース（merge+split相殺等）があるため常に更新
          if (state.layoutResultForNarrative) {
            // LayoutSection.visionFeatures(unknown) vs SectionVisionFeatures型の互換性のためキャスト
            state.layoutResultForNarrative.sections =
              postProcessedSections as unknown as NonNullable<LayoutServiceResult["sections"]>;
            state.layoutResultForNarrative.sectionCount = postProcessedSections.length;
          }

          if (isDevelopment()) {
            logger.info("[PageAnalyzeWorker] SectionPatterns saved", {
              count: state.sectionSaveResult.count,
              webPageId: actualWebPageId,
            });
          }
        } catch (sectionError) {
          // Graceful Degradation: SectionPattern保存失敗はジョブを中断しない
          logger.warn("[PageAnalyzeWorker] SectionPattern save failed", {
            error: sectionError instanceof Error ? sectionError.message : String(sectionError),
          });
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      statusTracker.failPhase("layout", errorMessage);
      failedPhases.push("layout");

      logger.warn("[PageAnalyzeWorker] Layout analysis failed", { error: errorMessage });
      await job.log(`[Phase 1] Layout FAILED: ${errorMessage}`);
    }
    await job.updateProgress(PHASE_PROGRESS.LAYOUT_COMPLETE);
    if (!failedPhases.includes("layout")) {
      const sectionCount = state.layoutResultForNarrative?.sections?.length ?? 0;
      await job.log(`[Phase 1] Layout complete: ${sectionCount} sections detected`);
    }
  } else {
    statusTracker.skipPhase("layout", "Disabled by options");
    await job.log("[Phase 1] Layout skipped (disabled)");
  }

  // =====================================================
  // Phase 1.1: Part Extraction (セクション内UIパーツ抽出)
  // Graceful Degradation: failure does NOT block subsequent phases.
  // =====================================================
  {
    const partExtractionEnabled =
      options.partExtractionOptions?.enabled !== false &&
      completedPhases.includes("layout") &&
      state.layoutResultForNarrative?.sections &&
      Array.isArray(state.layoutResultForNarrative.sections) &&
      state.layoutResultForNarrative.sections.length > 0 &&
      state.sectionSaveResult &&
      state.sectionSaveResult.idMapping.size > 0;

    if (partExtractionEnabled) {
      await job.updateProgress(PHASE_PROGRESS.PART_EXTRACTION_START);
      await extendJobLock(job, effectiveToken, effectiveLockDuration, "part-extraction");

      const partExtractionStartTime = Date.now();

      // RSS Memory Guard [C-1]
      const rssLimitBytes =
        options.partExtractionOptions?.rssLimitBytes ??
        DEFAULT_PART_EXTRACTION_CONFIG.rssLimitBytes;
      const currentRss = process.memoryUsage().rss;

      if (currentRss > rssLimitBytes) {
        logger.warn("[PageAnalyzeWorker] Part extraction skipped: RSS exceeds limit", {
          rss: currentRss,
          limit: rssLimitBytes,
        });
        await job.updateProgress(PHASE_PROGRESS.PART_EXTRACTION_COMPLETE);
      } else {
        // Build part extraction config
        const partConfig: PartExtractionConfig = {
          ...DEFAULT_PART_EXTRACTION_CONFIG,
          ...(options.partExtractionOptions?.timeoutMs !== undefined
            ? { timeoutMs: options.partExtractionOptions.timeoutMs }
            : {}),
          ...(options.partExtractionOptions?.rssLimitBytes !== undefined
            ? { rssLimitBytes: options.partExtractionOptions.rssLimitBytes }
            : {}),
        };

        const partTimeoutMs = partConfig.timeoutMs;

        // Track accumulated counts OUTSIDE Promise.race scope so timeout catch
        // can still propagate the partial count to Phase 5 embedding.
        // Without this, timeout → results.partExtraction undefined → partsSavedCount=0
        // → Phase 5 guard skips part embedding entirely despite parts being saved to DB.
        let accumulatedPartsSaved = 0;
        let accumulatedPartsExtracted = 0;
        let accumulatedSectionsProcessed = 0;

        try {
          // Wrap in independent timeout (30s default)
          const partExtractionResult = await Promise.race([
            (async (): Promise<{
              sectionsProcessed: number;
              totalPartsExtracted: number;
              totalPartsSaved: number;
            }> => {
              let sectionsProcessed = 0;
              let totalPartsExtracted = 0;
              let totalPartsSaved = 0;

              const sections = state.layoutResultForNarrative!.sections!;

              // OOM-2: screenshotPngPath から直接読み込み（Base64 二重デコード廃止）
              // Phase 0 で保存した PNG ファイルから直接 Buffer を読み込む。
              // Buffer.from(state.screenshotBase64, "base64") は ~80-150MB の
              // ネイティブメモリを確保し、glibc arena 断片化の原因となる。
              // OOM-2: Read directly from screenshotPngPath (eliminates double Base64 decode).
              // Phase 0 saved PNG file is read directly to avoid ~80-150MB native
              // memory allocation from Buffer.from(base64) that causes glibc arena fragmentation.
              let screenshotBuffer: Buffer | undefined;
              if (state.screenshotPngPath && fs.existsSync(state.screenshotPngPath)) {
                try {
                  screenshotBuffer = fs.readFileSync(state.screenshotPngPath);
                } catch {
                  logger.warn(
                    "[PageAnalyzeWorker] Failed to read screenshot PNG for part extraction"
                  );
                }
              } else if (state.screenshotBase64) {
                // Fallback: PNG ファイルがない場合のみ従来パス
                try {
                  screenshotBuffer = Buffer.from(state.screenshotBase64, "base64");
                } catch {
                  logger.warn(
                    "[PageAnalyzeWorker] Failed to decode screenshot for part extraction"
                  );
                }
              }

              for (let i = 0; i < sections.length; i++) {
                const section = sections[i];
                if (!section) continue;
                // Need a DB-saved sectionPatternId to save parts
                const sectionPatternId = state.sectionSaveResult!.idMapping.get(section.id);
                if (!sectionPatternId) continue;

                const sectionHtml = section.htmlSnippet ?? "";
                if (!sectionHtml) continue;

                try {
                  const extractionParams: Parameters<typeof deps.extractPartsFromSection>[0] = {
                    sectionHtml,
                    sectionIndex: i,
                    config: partConfig,
                    computedStylesMap: new Map<string, Record<string, string>>(),
                    sectionBoundingBox: {
                      x: 0,
                      y: section.position?.startY ?? 0,
                      width: 1280,
                      height: section.position?.height ?? 0,
                    },
                    sourceUrl: url,
                  };
                  if (screenshotBuffer) {
                    extractionParams.fullScreenshot = screenshotBuffer;
                  }
                  const extractionResult = await deps.extractPartsFromSection(extractionParams);

                  if (extractionResult.parts.length > 0) {
                    const saveResult: PartSaveResult = await deps.saveExtractedParts(
                      deps.prisma,
                      actualWebPageId,
                      sectionPatternId,
                      extractionResult.parts,
                      url
                    );
                    totalPartsSaved += saveResult.savedCount;
                    accumulatedPartsSaved = totalPartsSaved;
                  }

                  totalPartsExtracted += extractionResult.parts.length;
                  accumulatedPartsExtracted = totalPartsExtracted;
                  sectionsProcessed++;
                  accumulatedSectionsProcessed = sectionsProcessed;
                } catch (sectionError) {
                  // Per-section error: log and continue with other sections
                  logger.warn("[PageAnalyzeWorker] Part extraction failed for section", {
                    sectionIndex: i,
                    error: (sectionError as Error).message,
                  });
                }
              }

              return { sectionsProcessed, totalPartsExtracted, totalPartsSaved };
            })(),
            new Promise<never>((_resolve, reject) => {
              setTimeout(
                () => reject(new Error(`Part extraction timeout after ${partTimeoutMs}ms`)),
                partTimeoutMs
              );
            }),
          ]);

          const partDurationMs = Date.now() - partExtractionStartTime;
          results.partExtraction = {
            sectionsProcessed: partExtractionResult.sectionsProcessed,
            totalPartsExtracted: partExtractionResult.totalPartsExtracted,
            totalPartsSaved: partExtractionResult.totalPartsSaved,
            durationMs: partDurationMs,
          };

          if (isDevelopment()) {
            logger.info("[PageAnalyzeWorker] Part extraction completed (Phase 1.1)", {
              sectionsProcessed: partExtractionResult.sectionsProcessed,
              totalPartsExtracted: partExtractionResult.totalPartsExtracted,
              totalPartsSaved: partExtractionResult.totalPartsSaved,
              durationMs: partDurationMs,
            });
          }
        } catch (partError) {
          // Graceful Degradation: Phase 1.1 failure does NOT block subsequent phases
          const errorMessage = partError instanceof Error ? partError.message : String(partError);

          const partDurationMs = Date.now() - partExtractionStartTime;

          // Propagate partial count even on timeout: individual saveExtractedParts calls
          // commit parts to DB before timeout fires. Without this assignment, Phase 5
          // receives partsSavedCount=0 and skips part embedding generation entirely.
          if (accumulatedPartsSaved > 0) {
            results.partExtraction = {
              sectionsProcessed: accumulatedSectionsProcessed,
              totalPartsExtracted: accumulatedPartsExtracted,
              totalPartsSaved: accumulatedPartsSaved,
              durationMs: partDurationMs,
            };
          } else {
            // FIX(Bug-1): accumulatedPartsSaved=0 but async IIFE may have saved parts
            // after Promise.race timeout. The IIFE continues running in background and
            // commits parts to DB. Query actual DB count as authoritative fallback.
            // Without this, Phase 5 guard skips part embedding for ALL saved parts.
            try {
              const prismaClient = deps.prisma as {
                componentPart: {
                  count: (args: { where: { webPageId: string } }) => Promise<number>;
                };
              };
              const dbPartCount = await prismaClient.componentPart.count({
                where: { webPageId: actualWebPageId },
              });
              if (dbPartCount > 0) {
                results.partExtraction = {
                  sectionsProcessed: 0,
                  totalPartsExtracted: dbPartCount,
                  totalPartsSaved: dbPartCount,
                  durationMs: partDurationMs,
                };
                logger.info("[PageAnalyzeWorker] Part count recovered from DB after timeout", {
                  dbPartCount,
                  accumulatedPartsSaved: 0,
                });
              }
            } catch (countError) {
              logger.warn("[PageAnalyzeWorker] Part count DB query failed (non-fatal)", {
                error: (countError as Error).message,
              });
            }
          }

          logger.warn("[PageAnalyzeWorker] Part extraction failed (Phase 1.1, non-fatal)", {
            error: errorMessage,
            durationMs: partDurationMs,
            partsSavedBeforeTimeout: accumulatedPartsSaved,
          });
        }

        await job.updateProgress(PHASE_PROGRESS.PART_EXTRACTION_COMPLETE);
      }
    } else {
      if (isDevelopment()) {
        logger.debug("[PageAnalyzeWorker] Part extraction skipped (Phase 1.1)", {
          enabled: options.partExtractionOptions?.enabled !== false,
          layoutCompleted: completedPhases.includes("layout"),
          hasSections: !!state.layoutResultForNarrative?.sections?.length,
          hasSectionIds: !!(state.sectionSaveResult && state.sectionSaveResult.idMapping.size > 0),
        });
      }
    }
  }

  // OOM-4: Phase 1 完了後に Sharp (libvips) のキャッシュをクリア
  // Layout Analysis と Part Extraction で使用された libvips の内部キャッシュを解放し、
  // ネイティブメモリの蓄積を防止する。Phase 5 では独自に sharp.cache(false) を設定する。
  // OOM-4: Clear Sharp (libvips) cache after Phase 1 completion.
  // Releases libvips internal cache used by Layout Analysis and Part Extraction
  // to prevent native memory accumulation. Phase 5 sets sharp.cache(false) independently.
  sharp.cache(false);
  sharp.cache(true);
}
