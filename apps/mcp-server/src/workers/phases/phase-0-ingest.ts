// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 0 (Ingest) & Phase 0.5 (WebPage DB save)
 *
 * Extracted from page-analyze-worker.ts (TDA-C1) for phase-level modularity.
 *
 * Phase 0: HTML Ingest via PageIngestAdapter (Playwright-based)
 * Phase 0.5: WebPage DB upsert (sanitizedHtml, htmlHash, normalizedUrl)
 *
 * @module workers/phases/phase-0-ingest
 */

import { createHash } from "crypto";
import type { Browser } from "playwright";

import type { IngestAdapterOptions, IngestResult } from "../../services/page-ingest-adapter";
import { sanitizeHtml } from "../../utils/html-sanitizer";
import { logger, isDevelopment } from "../../utils/logger";
import { normalizeUrlForStorage } from "../../utils/url-normalizer";

import {
  type PipelineState,
  type PhaseContext,
  PHASE_PROGRESS,
  HTML_LARGE_THRESHOLD,
  HTML_HUGE_THRESHOLD,
  tryGarbageCollect,
} from "./types";
import { createPhase5TempDir, saveScreenshotAsPng } from "./phase-5-raw-decode";

// ============================================================================
// Types
// ============================================================================

/**
 * Phase 0 (Ingest) の依存注入インターフェース
 *
 * テスト容易性のため、pageIngestAdapter と prisma を外部から注入する。
 * Dependency injection interface for Phase 0 (Ingest) to enable testability.
 */
export interface IngestPhaseDeps {
  pageIngestAdapter: {
    ingest: (options: IngestAdapterOptions & { url: string }) => Promise<IngestResult>;
    getSharedBrowser: () => Promise<Browser>;
  };
  prisma: {
    webPage: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma upsert args use SelectSubset<T> generics incompatible with structural types
      upsert: (args: any) => Promise<{ id: string }>;
    };
  };
}

// ============================================================================
// Phase 0: Ingest + Phase 0.5: WebPage DB Save
// ============================================================================

/**
 * Phase 0 (HTML Ingest) および Phase 0.5 (WebPage DB save) を実行する。
 *
 * 1. PageIngestAdapter 経由で HTML + スクリーンショットを取得
 * 2. 共有ブラウザインスタンスを取得
 * 3. HTML サイズに基づく事前劣化判定（narrative/vision の無効化）
 * 4. saveToDb !== false の場合、サニタイズ済み HTML を WebPage テーブルに upsert
 * 5. メモリクリーンアップ（tryGarbageCollect）
 *
 * Executes Phase 0 (HTML Ingest) and Phase 0.5 (WebPage DB save).
 *
 * @param state  - Mutable pipeline state (html, screenshotBase64, etc. are written here)
 * @param ctx    - Immutable phase context (job, options, url, webPageId, statusTracker)
 * @param deps   - Injected dependencies (pageIngestAdapter, prisma)
 * @returns The shared Browser instance for subsequent phases
 */
export async function processIngestPhase(
  state: PipelineState,
  ctx: PhaseContext,
  deps: IngestPhaseDeps
): Promise<Browser> {
  const { job, options, url, webPageId, statusTracker } = ctx;

  // =====================================================
  // Phase 0: Ingest (HTML取得)
  // =====================================================
  statusTracker.startPhase("initializing");
  await job.updateProgress(PHASE_PROGRESS.INGEST_START);
  await job.log(`[Phase 0] Ingest started: ${url}`);

  if (isDevelopment()) {
    logger.debug("[PageAnalyzeWorker] Starting HTML fetch", { url });
  }

  const fetchTimeout = options.timeout ?? 60000;
  const ingestOptions: IngestAdapterOptions & { url: string } = {
    url,
    timeout: fetchTimeout,
    // PageIngestAdapter features: DOM stability, WebGL detection, user interaction
    waitForDomStable: true,
    simulateUserInteraction: true,
    skipScreenshot: false,
    ...(options.layoutOptions?.viewport
      ? {
          viewport: {
            width: options.layoutOptions.viewport.width,
            height: options.layoutOptions.viewport.height,
          },
        }
      : {}),
  };
  const ingestResult = await deps.pageIngestAdapter.ingest(ingestOptions);

  if (!ingestResult.success || !ingestResult.html) {
    throw new Error(ingestResult.error ?? "Failed to fetch HTML content");
  }

  const html: string | null = ingestResult.html;
  // Extract screenshot reference early; ingestResult will be released after Phase 0.5
  const screenshotBase64: string | undefined = ingestResult.screenshots?.[0]?.data;
  statusTracker.completePhase("initializing");
  state.completedPhases.push("ingest");
  await job.updateProgress(PHASE_PROGRESS.INGEST_COMPLETE);
  await job.log(
    `[Phase 0] Ingest complete: HTML ${html ? `${Math.round(html.length / 1024)}KB` : "empty"}, screenshot ${screenshotBase64 ? "captured" : "none"}`
  );

  // Store in pipeline state
  state.html = html;
  state.screenshotBase64 = screenshotBase64;

  // =====================================================
  // Phase 0 PNG ファイル保存: Phase 5 RAW デコード最適化用
  // screenshotBase64 を PNG ファイルに保存し、Phase 5 で1回だけ RAW デコードする。
  // screenshotBase64 はまだ Phase 2/2.5 で使用されるため、メモリから解放しない。
  // =====================================================
  if (screenshotBase64) {
    try {
      const phase5TmpDir = createPhase5TempDir();
      const pngPath = saveScreenshotAsPng(phase5TmpDir, screenshotBase64);
      state.screenshotPngPath = pngPath;

      if (isDevelopment()) {
        logger.debug("[PageAnalyzeWorker] Screenshot saved as PNG for Phase 5 RAW decode", {
          pngPath,
          tmpDir: phase5TmpDir,
        });
      }
    } catch (pngSaveError) {
      // Graceful Degradation: PNG保存失敗時はPhase 5で従来パスを使用
      logger.warn(
        "[PageAnalyzeWorker] Failed to save screenshot PNG (non-fatal, Phase 5 will use legacy path)",
        {
          error: pngSaveError instanceof Error ? pngSaveError.message : String(pngSaveError),
        }
      );
    }
  }

  // =====================================================
  // Browser sharing: PageIngestAdapterのブラウザを再利用（4→1プロセス削減）
  // ScrollVision, JSAnimation, WebGL検出で共有し、OOMクラッシュを防止
  // =====================================================
  const sharedBrowser = await deps.pageIngestAdapter.getSharedBrowser();

  if (isDevelopment()) {
    logger.debug("[PageAnalyzeWorker] HTML fetch completed", {
      htmlLength: html.length,
      hasScreenshot: !!screenshotBase64,
      sharedBrowserConnected: sharedBrowser.isConnected(),
    });
  }

  // =====================================================
  // HTML size pre-degradation check
  // =====================================================
  // Heavy JS sites produce large HTML; preemptively disable expensive phases
  // to prevent OOM before memory pressure actually builds up
  if (html.length > HTML_HUGE_THRESHOLD) {
    logger.warn("[PageAnalyzeWorker] [Large HTML] Disabling narrative+vision", {
      htmlLength: html.length,
      threshold: HTML_HUGE_THRESHOLD,
      url,
    });
    state.narrativePreDisabled = true;
    state.visionPreDisabled = true;
  } else if (html.length > HTML_LARGE_THRESHOLD) {
    logger.warn("[PageAnalyzeWorker] [Large HTML] Disabling vision LLM", {
      htmlLength: html.length,
      threshold: HTML_LARGE_THRESHOLD,
      url,
    });
    state.visionPreDisabled = true;
  }

  // =====================================================
  // Phase 0.5: WebPage DB保存（async mode固有）
  // =====================================================
  // saveToDb が明示的に false でない限り、WebPageレコードを保存
  // これにより layout.inspect(pageId=webPageId) でのNOT_FOUNDを防止
  if (options.layoutOptions?.saveToDb !== false) {
    try {
      // HTMLをサニタイズ（XSS対策 - DB保存用）
      // preserveDocumentStructure: true でドキュメント構造を保持
      // aXeアクセシビリティ検証で<html lang>と<title>が必要
      // セキュリティ契約: 1.5MB超のHTMLではDOMPurifyがバイパスされ、
      // preStripDangerousTagsのみ適用される。この場合、属性ベースXSS
      // (onerror, javascript:URL等)が残存する。このHTMLはDB保存専用であり、
      // ブラウザで直接レンダリングしてはならない。
      const sanitizedHtml = sanitizeHtml(html, { preserveDocumentStructure: true });
      const htmlHash = createHash("sha256").update(sanitizedHtml).digest("hex");

      // URLを正規化（末尾スラッシュ除去等）して重複を防止
      const normalizedUrl = normalizeUrlForStorage(url);

      // WebPageテーブルに保存（upsert: URLが重複する場合は更新）
      // v0.1.0: upsertの結果から実際のIDを取得（既存レコードの場合は既存IDが返される）
      const upsertResult = await deps.prisma.webPage.upsert({
        where: { url: normalizedUrl },
        create: {
          id: webPageId,
          url: normalizedUrl,
          title: null,
          description: null,
          sourceType: "user_provided",
          usageScope: "inspiration_only",
          htmlContent: sanitizedHtml,
          htmlHash,
          crawledAt: new Date(),
          analysisStatus: "pending",
        },
        update: {
          htmlContent: sanitizedHtml,
          htmlHash,
          crawledAt: new Date(),
          analysisStatus: "pending",
        },
        select: { id: true },
      });

      // v0.1.0: actualWebPageIdを更新（layout.inspect等で正しいIDを使用するため）
      state.actualWebPageId = upsertResult.id;

      if (isDevelopment()) {
        logger.debug("[PageAnalyzeWorker] WebPage saved to DB", {
          requestedWebPageId: webPageId,
          actualWebPageId: state.actualWebPageId,
          isExistingRecord: webPageId !== state.actualWebPageId,
          url,
          htmlLength: sanitizedHtml.length,
        });
      }
    } catch (dbError) {
      // DB保存失敗時は警告ログのみ出力し、ジョブは続行
      // Graceful Degradation: DB保存は失敗してもLayout/Motion/Quality解析は実行可能
      const errorMessage = dbError instanceof Error ? dbError.message : String(dbError);
      logger.warn("[PageAnalyzeWorker] WebPage DB save failed (continuing job)", {
        webPageId,
        url,
        error: errorMessage,
      });
    }
  }

  // =====================================================
  // Memory Cleanup: Release ingestResult after Phase 0.5
  // html content is held in `html` variable, screenshot in `screenshotBase64`
  // =====================================================
  {
    const beforeRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
    tryGarbageCollect();
    if (isDevelopment()) {
      const afterRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      logger.debug("[PageAnalyzeWorker] [MemCleanup] ingestResult released", {
        beforeRssMb: beforeRss,
        afterRssMb: afterRss,
        reclaimedMb: beforeRss - afterRss,
      });
    }
  }

  return sharedBrowser;
}
