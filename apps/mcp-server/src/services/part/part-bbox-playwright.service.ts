// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Part Bounding Box Playwright Service
 *
 * Phase 5 DINOv2 Visual Embedding ブロック冒頭で、JSDOMの制約により
 * 常に {x:0, y:0, width:0, height:0} となる bounding box を
 * Playwright の実レンダリング結果で後付け更新するサービス。
 *
 * Resolves bounding boxes for parts extracted by JSDOM (which always returns
 * {x:0, y:0, width:0, height:0}) using actual Playwright rendering results.
 * Called at the beginning of Phase 5 DINOv2 visual embedding block.
 *
 * パターン: scroll-vision-capture.service.ts の sharedBrowser パターンに準拠。
 * Pattern: Follows sharedBrowser pattern from scroll-vision-capture.service.ts.
 *
 * robots.txt: このサービスは page-analyze-worker (Phase 5) 内からのみ呼ばれることを前提とする。
 * robots.txt の検証は Phase 0 (PageIngestAdapter.ingest) で実施済みであり、
 * ここでは重複検証しない。同一URLへの再訪問のため、別途のrobots.txt確認は不要。
 *
 * robots.txt: This service is designed to be called only from page-analyze-worker (Phase 5).
 * robots.txt validation is already performed in Phase 0 (PageIngestAdapter.ingest),
 * so it is not duplicated here. Since this is a re-visit to the same URL, no additional
 * robots.txt check is required.
 *
 * @module services/part/part-bbox-playwright.service
 */

import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import type { PrismaClient, Prisma } from "@prisma/client";
import { validateExternalUrl } from "../../utils/url-validator";
import { logger, isDevelopment } from "../../utils/logger";
import { truncateId } from "./schemas";
import { TAG_TO_PART_TYPE } from "./types";

// ============================================================================
// Constants / 定数
// ============================================================================

const LOG_PREFIX = "[PartBboxPlaywright]";

/**
 * デフォルトビューポートサイズ / Default viewport size
 */
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

/**
 * ナビゲーションタイムアウト（ミリ秒） / Navigation timeout (milliseconds)
 */
const NAVIGATION_TIMEOUT_MS = 30_000;

/**
 * ナビゲーション完了後の追加待機（ミリ秒）
 * Additional wait after navigation (milliseconds)
 */
const POST_NAVIGATION_WAIT_MS = 1_000;

// ============================================================================
// PR-D-9 Wave 4 (C-06 / FIND-PLAN-SEC-02): BBOX_RESOLVE_RELOAD safety budget
// ============================================================================
//
// `dom_disposed` 等の 1st-pass 失敗 part に対し、Playwright `page.reload()` を
// opt-in で試行する。
//   - default: disabled (`BBOX_RESOLVE_RELOAD_ENABLED=false`).
//   - per-page max reload count cap (`BBOX_RESOLVE_RELOAD_ENABLED_MAX_RELOADS_PER_PAGE`,
//     default 5) + cumulative timeout cap (`BBOX_RESOLVE_RELOAD_TOTAL_TIMEOUT_MS`,
//     default 60000 = 60s). On either cap, residual unresolved parts emit
//     `skipReason='bbox_unresolvable'` (fail-closed) per ADR-0018 §Decision 1
//     Supplement S3 mutual exclusivity contract.
//
// On opt-in: per-page Playwright `page.reload()` is attempted for 1st-pass
// failures. Default false. Two safety budgets (max reload count + cumulative
// timeout) are fail-closed: when either is exhausted, residual parts emit
// `bbox_unresolvable` rather than silently looping.
//
// @see Plan v1.1 §4.3.2 / §5.1.6 / §6.2 case #6
// @see ADR-0018 §Decision 1 Supplement S3 (`bbox_invalid` vs `bbox_unresolvable`)

const BBOX_RELOAD_ENABLED_DEFAULT = false;
const BBOX_RELOAD_MAX_RELOADS_PER_PAGE_DEFAULT = 5;
const BBOX_RELOAD_TOTAL_TIMEOUT_MS_DEFAULT = 60_000;

/**
 * Strict env var parser: returns the default when the value is undefined,
 * empty, NaN, or out of `[1, absoluteCap]` range. Accepts only positive
 * integers (rejects `"0"` / negatives / floats with logger.warn).
 *
 * @internal exported for unit tests
 */
export function parseBboxReloadIntEnv(
  raw: string | undefined,
  defaultValue: number,
  absoluteCap: number,
  envVarName: string
): number {
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(`${LOG_PREFIX} ${envVarName}=${raw} is not a positive integer; using default`, {
      raw,
      defaultValue,
    });
    return defaultValue;
  }
  if (parsed > absoluteCap) {
    logger.warn(
      `${LOG_PREFIX} ${envVarName}=${parsed} exceeds absolute cap ${absoluteCap}; clamped`,
      { raw, parsed, absoluteCap }
    );
    return absoluteCap;
  }
  return parsed;
}

/**
 * Resolve the reload safety budget from env vars (PR-D-9 Wave 4 / C-06).
 *
 * @internal exported for unit tests
 */
export function resolveBboxReloadBudget(): {
  enabled: boolean;
  maxReloadsPerPage: number;
  totalTimeoutMs: number;
} {
  const flag = process.env["BBOX_RESOLVE_RELOAD_ENABLED"];
  // Strict semantics: only `"true"` enables. Mirror worker-bootstrap C-11
  // policy (FIND-PLAN-SEC-04 silent-enable risk mitigation).
  const enabled = flag === "true" ? true : BBOX_RELOAD_ENABLED_DEFAULT;
  if (flag !== undefined && flag !== "true" && flag !== "false") {
    logger.warn(
      `${LOG_PREFIX} non-canonical BBOX_RESOLVE_RELOAD_ENABLED value; treating as default (false). Accept only 'true'/'false'.`,
      { flag }
    );
  }
  const maxReloadsPerPage = parseBboxReloadIntEnv(
    process.env["BBOX_RESOLVE_RELOAD_ENABLED_MAX_RELOADS_PER_PAGE"],
    BBOX_RELOAD_MAX_RELOADS_PER_PAGE_DEFAULT,
    100,
    "BBOX_RESOLVE_RELOAD_ENABLED_MAX_RELOADS_PER_PAGE"
  );
  const totalTimeoutMs = parseBboxReloadIntEnv(
    process.env["BBOX_RESOLVE_RELOAD_TOTAL_TIMEOUT_MS"],
    BBOX_RELOAD_TOTAL_TIMEOUT_MS_DEFAULT,
    600_000,
    "BBOX_RESOLVE_RELOAD_TOTAL_TIMEOUT_MS"
  );
  return { enabled, maxReloadsPerPage, totalTimeoutMs };
}

// ============================================================================
// Type Definitions / 型定義
// ============================================================================

/**
 * resolvePartBoundingBoxes のパラメータ
 * Parameters for resolvePartBoundingBoxes
 */
export interface ResolvePartBoundingBoxesParams {
  /** WebPage DB ID */
  webPageId: string;
  /** ソースURL / Source URL */
  url: string;
  /** Prismaクライアント / Prisma client */
  prisma: PrismaClient;
  /** 共有ブラウザインスタンス（省略時は独自起動） / Shared browser instance (launches own if omitted) */
  sharedBrowser?: Browser | undefined;
  /** ビューポート幅 / Viewport width */
  viewportWidth?: number | undefined;
  /** ビューポート高さ / Viewport height */
  viewportHeight?: number | undefined;
}

/**
 * resolvePartBoundingBoxes の結果
 * Result of resolvePartBoundingBoxes
 */
export interface ResolvePartBoundingBoxesResult {
  /** bounding box を更新したパーツ数 / Number of parts with updated bounding boxes */
  resolvedCount: number;
  /** マッチできずスキップしたパーツ数 / Number of parts skipped (no match found) */
  skippedCount: number;
  /**
   * PR-D-9 Wave 4 (C-06): observability fields for the BBOX_RESOLVE_RELOAD
   * safety budget. Always present (0 when reload pass disabled / not entered).
   *
   * 観測性: BBOX_RESOLVE_RELOAD safety budget の per-page metrics。reload pass
   * が走らなかった場合は両 field とも 0。CO-PRDD9-05 metrics design に対応。
   */
  reloadCount?: number;
  reloadTotalTimeMs?: number;
  reloadBudgetExhausted?: boolean;
}

/**
 * page.evaluate に渡すパーツセレクタデータ
 * Part selector data passed to page.evaluate
 */
interface PartSelectorData {
  /** DB パーツID / DB part ID */
  id: string;
  /** CSSセレクタ候補（優先度順） / CSS selector candidates (in priority order) */
  selectors: string[];
  /** セクションの絶対Y開始座標 / Section absolute Y start coordinate */
  sectionStartY: number;
  /** 同一セクション内の同一partType別インデックス / Per-partType index within section */
  sampleIndex: number;
}

/**
 * page.evaluate から返るbounding box結果
 * Bounding box result returned from page.evaluate
 */
interface BboxResult {
  /** DB パーツID / DB part ID */
  id: string;
  /** セクション相対X座標 / Section-relative X coordinate */
  x: number;
  /** セクション相対Y座標 / Section-relative Y coordinate */
  y: number;
  /** 幅 / Width */
  width: number;
  /** 高さ / Height */
  height: number;
}

// ============================================================================
// Lookup Tables / ルックアップテーブル
// ============================================================================

/**
 * TAG_TO_PART_TYPE の逆引きマップ: partType → HTMLタグ名配列
 * Inverted TAG_TO_PART_TYPE: partType → HTML tag name array
 *
 * 例 / Example: 'heading' → ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']
 */
const PART_TYPE_TO_TAGS = buildPartTypeToTagsMap();

function buildPartTypeToTagsMap(): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, string[]>();
  for (const [tag, partType] of Object.entries(TAG_TO_PART_TYPE)) {
    const existing = map.get(partType) ?? [];
    existing.push(tag);
    map.set(partType, existing);
  }
  return map;
}

// ============================================================================
// Main Function / メイン関数
// ============================================================================

/**
 * Playwright でパーツの bounding box を後付け取得し DB を更新する
 * Resolve part bounding boxes via Playwright and update DB
 *
 * 1. DB から boundingBox が {width:0, height:0} のパーツを取得
 * 2. Playwright でページをレンダリング
 * 3. page.evaluate() で全パーツの bounding box を一括取得
 * 4. prisma.$transaction で一括更新
 *
 * Graceful Degradation: 失敗時は resolvedCount=0 で返す（ジョブを中断しない）
 *
 * @param params - 取得パラメータ / Resolution parameters
 * @returns 更新結果 / Resolution result
 */
export async function resolvePartBoundingBoxes(
  params: ResolvePartBoundingBoxesParams
): Promise<ResolvePartBoundingBoxesResult> {
  const { webPageId, url, prisma, viewportWidth, viewportHeight } = params;

  // 1. SSRF検証 / SSRF validation
  const urlValidation = validateExternalUrl(url);
  if (!urlValidation.valid) {
    logger.warn(`${LOG_PREFIX} URL blocked by SSRF validation`, {
      error: urlValidation.error,
    });
    return { resolvedCount: 0, skippedCount: 0 };
  }

  // 2. DB から bounding box が未解決のパーツを取得
  //    Query parts with zero-size bounding boxes from DB
  const allParts = await prisma.componentPart.findMany({
    where: {
      webPageId,
      piiRiskLevel: { not: "high" },
    },
    select: {
      id: true,
      partType: true,
      cssClasses: true,
      sectionPatternId: true,
      boundingBox: true,
      sampleIndex: true,
    },
  });

  // boundingBox が null または width/height <= 0 のパーツをフィルタ
  // Filter to parts with null or zero-size bounding boxes
  const partsNeedingBbox = allParts.filter((p) => {
    const bbox = p.boundingBox as Record<string, number | undefined> | null;
    if (!bbox) return true;
    const w = bbox.width ?? 0;
    const h = bbox.height ?? 0;
    return w <= 0 || h <= 0;
  });

  if (partsNeedingBbox.length === 0) {
    if (isDevelopment()) {
      logger.info(`${LOG_PREFIX} No parts need bbox resolution`, {
        webPageId: truncateId(webPageId),
      });
    }
    return { resolvedCount: 0, skippedCount: 0 };
  }

  // 3. セクションの startY 位置を取得（セクション相対座標変換用）
  //    Get section startY positions (for section-relative coordinate conversion)
  const uniqueSectionIds = [...new Set(partsNeedingBbox.map((p) => p.sectionPatternId))];
  const sectionPositions = await prisma.sectionPattern.findMany({
    where: { id: { in: uniqueSectionIds } },
    select: { id: true, layoutInfo: true },
  });
  const sectionStartYMap = new Map<string, number>();
  for (const s of sectionPositions) {
    const info = s.layoutInfo as Record<string, unknown> | null;
    const position = info?.position as { startY?: number } | undefined;
    sectionStartYMap.set(s.id, position?.startY ?? 0);
  }

  // 4. パーツごとにCSSセレクタを構築
  //    Build CSS selectors for each part
  const selectorData: PartSelectorData[] = partsNeedingBbox.map((p) => ({
    id: p.id,
    selectors: buildSelectorsForPart(p.partType, p.cssClasses),
    sectionStartY: sectionStartYMap.get(p.sectionPatternId) ?? 0,
    sampleIndex: p.sampleIndex,
  }));

  // 5. Playwright でページをレンダリングし bounding box を取得
  //    Render page with Playwright and resolve bounding boxes
  //    共有ブラウザが渡されていても切断済み（Phase 2 後に close 済み）なら独自起動にフォールバック
  //    Falls back to launching own browser if shared browser is disconnected (closed after Phase 2)
  const sharedBrowserConnected = params.sharedBrowser?.isConnected() === true;
  const usingSharedBrowser = sharedBrowserConnected;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    // ブラウザ取得（接続済み共有 or 新規起動） / Get browser (connected shared or launch new)
    if (usingSharedBrowser) {
      browser = params.sharedBrowser!;
    } else {
      browser = await chromium.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      });
    }

    const viewport = {
      width: viewportWidth ?? DEFAULT_VIEWPORT.width,
      height: viewportHeight ?? DEFAULT_VIEWPORT.height,
    };

    context = await browser.newContext({
      viewport,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Reftrix/0.3.0",
      javaScriptEnabled: true,
      bypassCSP: false,
    });

    page = await context.newPage();

    // ナビゲーション / Navigate
    const response = await page.goto(url, {
      waitUntil: "load",
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    if (response) {
      const status = response.status();
      if (status >= 400) {
        logger.warn(`${LOG_PREFIX} HTTP error during navigation`, { url, status });
        return { resolvedCount: 0, skippedCount: partsNeedingBbox.length };
      }
    }

    // ページ読み込み後の待機（lazy-load, アニメーション初期化） / Post-navigation wait
    await page.waitForTimeout(POST_NAVIGATION_WAIT_MS);

    // 6. page.evaluate() で全パーツの bounding box を一括取得
    //    Resolve all bounding boxes in a single page.evaluate() call
    const resolvedBboxes = await page.evaluate(
      (data: PartSelectorData[]): Array<BboxResult | null> => {
        // マッチ済み要素を追跡（同一要素の重複マッチ防止）
        // Track matched elements to prevent duplicate matching
        const globalMatched = new Set<Element>();
        const results: Array<BboxResult | null> = [];

        for (const part of data) {
          let found = false;

          for (const selector of part.selectors) {
            if (found) break;

            let elements: NodeListOf<Element>;
            try {
              elements = document.querySelectorAll(selector);
            } catch {
              // 不正なセレクタはスキップ / Skip invalid selectors
              continue;
            }

            // sectionStartY 付近の要素のみをフィルタし、sampleIndex でマッチ
            // Filter elements near sectionStartY and match by sampleIndex
            let matchIndex = 0;
            for (const el of elements) {
              if (globalMatched.has(el)) continue;

              const rect = el.getBoundingClientRect();
              if (rect.width <= 0 || rect.height <= 0) continue;

              // 要素の絶対Y座標を計算 / Calculate absolute Y coordinate
              const absoluteY = rect.top + window.scrollY;

              // セクション範囲内かチェック（startY から ±500px の許容範囲）
              // Check if within section range (±500px tolerance from startY)
              const sectionTolerance = 500;
              if (Math.abs(absoluteY - part.sectionStartY) > sectionTolerance + rect.height) {
                continue;
              }

              // sampleIndex によるマッチング / Match by sampleIndex
              if (matchIndex === part.sampleIndex) {
                globalMatched.add(el);

                // セクション相対座標に変換 / Convert to section-relative coordinates
                results.push({
                  id: part.id,
                  x: Math.max(0, rect.left),
                  y: Math.max(0, absoluteY - part.sectionStartY),
                  width: rect.width,
                  height: rect.height,
                });
                found = true;
                break;
              }
              matchIndex++;
            }
          }

          if (!found) {
            results.push(null);
          }
        }

        return results;
      },
      selectorData
    );

    // 7. DB を一括更新 / Batch update DB
    const updates: Array<{
      id: string;
      bbox: { x: number; y: number; width: number; height: number };
    }> = [];
    const skippedSelectors: PartSelectorData[] = [];

    for (let i = 0; i < resolvedBboxes.length; i++) {
      const bbox = resolvedBboxes[i];
      if (bbox !== null && bbox !== undefined) {
        updates.push({
          id: bbox.id,
          bbox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
        });
      } else {
        // selectorData[i] is the corresponding skipped part (resolvedBboxes
        // preserves order from page.evaluate input).
        const skippedSelector = selectorData[i];
        if (skippedSelector !== undefined) {
          skippedSelectors.push(skippedSelector);
        }
      }
    }

    // PR-D-9 Wave 4 (C-06 / FIND-PLAN-SEC-02): opt-in BBOX_RESOLVE_RELOAD pass.
    // When `BBOX_RESOLVE_RELOAD_ENABLED=true`, retry skipped parts via
    // `page.reload()` within the per-page max reload count + cumulative
    // timeout safety budget. On budget exhaustion or pass completion,
    // residual skipped parts remain unresolved (caller emits
    // `bbox_unresolvable` per ADR-0018 §Decision 1 Supplement S3).
    //
    // Opt-in reload pass per Plan v1.1 §4.3.2 / §6.2 case #6.
    let reloadCount = 0;
    let reloadTotalTimeMs = 0;
    let reloadBudgetExhausted = false;
    if (skippedSelectors.length > 0) {
      const budget = resolveBboxReloadBudget();
      if (budget.enabled) {
        const reloadOutcome = await runBboxReloadPass({
          page,
          skippedSelectors,
          budget,
        });
        reloadCount = reloadOutcome.reloadCount;
        reloadTotalTimeMs = reloadOutcome.reloadTotalTimeMs;
        reloadBudgetExhausted = reloadOutcome.budgetExhausted;
        for (const bbox of reloadOutcome.recovered) {
          updates.push({
            id: bbox.id,
            bbox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
          });
        }
      }
    }

    const finalSkippedCount = partsNeedingBbox.length - updates.length;

    if (updates.length > 0) {
      await prisma.$transaction(
        updates.map((u) =>
          prisma.componentPart.update({
            where: { id: u.id },
            data: { boundingBox: u.bbox as unknown as Prisma.InputJsonValue },
          })
        )
      );
    }

    if (isDevelopment()) {
      logger.info(`${LOG_PREFIX} Bounding box resolution completed`, {
        webPageId: truncateId(webPageId),
        resolvedCount: updates.length,
        skippedCount: finalSkippedCount,
        totalParts: partsNeedingBbox.length,
        reloadCount,
        reloadTotalTimeMs,
        reloadBudgetExhausted,
      });
    }

    return {
      resolvedCount: updates.length,
      skippedCount: finalSkippedCount,
      reloadCount,
      reloadTotalTimeMs,
      reloadBudgetExhausted,
    };
  } catch (error) {
    // Graceful Degradation: bbox取得失敗はジョブを中断しない
    // Graceful Degradation: bbox resolution failure is non-fatal
    logger.warn(`${LOG_PREFIX} Bounding box resolution failed (non-fatal)`, {
      webPageId: truncateId(webPageId),
      error: error instanceof Error ? error.message : String(error),
    });
    return { resolvedCount: 0, skippedCount: partsNeedingBbox.length };
  } finally {
    // リソースクリーンアップ / Resource cleanup
    if (page) {
      await page.close().catch(() => {
        /* ignore */
      });
    }
    if (context) {
      await context.close().catch(() => {
        /* ignore */
      });
    }
    // 共有ブラウザの場合はブラウザを閉じない（呼び出し元が管理）
    // Don't close shared browser (managed by caller)
    if (browser && !usingSharedBrowser) {
      await browser.close().catch(() => {
        /* ignore */
      });
    }
  }
}

// ============================================================================
// PR-D-9 Wave 4 (C-06 / FIND-PLAN-SEC-02): BBOX_RESOLVE_RELOAD pass
// ============================================================================

/**
 * Reload pass の結果
 * Result of the BBOX_RESOLVE_RELOAD pass
 */
interface BboxReloadPassResult {
  /** Reload で recover した bounding box / Bounding boxes recovered via reload */
  recovered: BboxResult[];
  /** Page.reload() を呼び出した回数 / Number of `page.reload()` invocations */
  reloadCount: number;
  /** Reload pass 全体の経過時間 (ms) / Total elapsed time of the reload pass (ms) */
  reloadTotalTimeMs: number;
  /** Safety budget が exhaust した場合 true / true when safety budget exhausted */
  budgetExhausted: boolean;
}

/**
 * Reload pass の入力パラメータ / Reload pass input parameters
 */
interface BboxReloadPassParams {
  page: Page;
  skippedSelectors: PartSelectorData[];
  budget: {
    enabled: boolean;
    maxReloadsPerPage: number;
    totalTimeoutMs: number;
  };
}

/**
 * PR-D-9 Wave 4 (C-06): opt-in `page.reload()` based recovery pass for parts
 * that failed the 1st-pass resolution (e.g., `dom_disposed` cases).
 *
 * Safety budget contract (fail-closed):
 *   - Per-page reload count cap: at most `budget.maxReloadsPerPage` reloads.
 *   - Cumulative timeout cap: aborts when elapsed time >= `budget.totalTimeoutMs`.
 *   - On either cap, residual unresolved parts are returned as not-recovered;
 *     the caller emits `skipReason='bbox_unresolvable'` per ADR-0018 §Decision 1
 *     Supplement S3 (mutually exclusive with `bbox_invalid`).
 *
 * @internal exported indirectly via `resolvePartBoundingBoxes` reload pass
 */
async function runBboxReloadPass(params: BboxReloadPassParams): Promise<BboxReloadPassResult> {
  const { page, skippedSelectors, budget } = params;
  const startedAt = Date.now();
  let reloadCount = 0;
  const recovered: BboxResult[] = [];
  let remainingSelectors = [...skippedSelectors];

  // Loop until either (a) all skipped resolved, (b) max reloads reached, or
  // (c) cumulative timeout exhausted.
  while (
    remainingSelectors.length > 0 &&
    reloadCount < budget.maxReloadsPerPage &&
    Date.now() - startedAt < budget.totalTimeoutMs
  ) {
    try {
      // Cumulative timeout-aware reload (Playwright `timeout` is per-call).
      const timeRemaining = budget.totalTimeoutMs - (Date.now() - startedAt);
      const reloadTimeout = Math.max(1_000, Math.min(NAVIGATION_TIMEOUT_MS, timeRemaining));
      await page.reload({ waitUntil: "load", timeout: reloadTimeout });
      reloadCount++;
      await page.waitForTimeout(POST_NAVIGATION_WAIT_MS);
    } catch (reloadError) {
      // Reload failure is non-fatal — record the attempt count and exit the
      // pass (residual parts emit `bbox_unresolvable` downstream).
      logger.warn(`${LOG_PREFIX} page.reload() failed during BBOX_RESOLVE_RELOAD pass`, {
        error: reloadError instanceof Error ? reloadError.message : String(reloadError),
        reloadCount,
        remainingCount: remainingSelectors.length,
      });
      break;
    }

    // Re-resolve only the still-unresolved subset. Reuse the same page.evaluate
    // logic shape as the 1st-pass call site (kept inline to avoid extracting a
    // separate helper that would inflate file LoC beyond Plan §5.1.6 estimate).
    let evalResult: Array<BboxResult | null>;
    try {
      evalResult = await page.evaluate((data: PartSelectorData[]): Array<BboxResult | null> => {
        const globalMatched = new Set<Element>();
        const results: Array<BboxResult | null> = [];
        for (const part of data) {
          let found = false;
          for (const selector of part.selectors) {
            if (found) break;
            let elements: NodeListOf<Element>;
            try {
              elements = document.querySelectorAll(selector);
            } catch {
              continue;
            }
            let matchIndex = 0;
            for (const el of elements) {
              if (globalMatched.has(el)) continue;
              const rect = el.getBoundingClientRect();
              if (rect.width <= 0 || rect.height <= 0) continue;
              const absoluteY = rect.top + window.scrollY;
              const sectionTolerance = 500;
              if (Math.abs(absoluteY - part.sectionStartY) > sectionTolerance + rect.height) {
                continue;
              }
              if (matchIndex === part.sampleIndex) {
                globalMatched.add(el);
                results.push({
                  id: part.id,
                  x: Math.max(0, rect.left),
                  y: Math.max(0, absoluteY - part.sectionStartY),
                  width: rect.width,
                  height: rect.height,
                });
                found = true;
                break;
              }
              matchIndex++;
            }
          }
          if (!found) {
            results.push(null);
          }
        }
        return results;
      }, remainingSelectors);
    } catch (evalError) {
      // page.evaluate failure (e.g., page disposed mid-pass) is non-fatal.
      logger.warn(`${LOG_PREFIX} page.evaluate() failed during reload pass`, {
        error: evalError instanceof Error ? evalError.message : String(evalError),
        reloadCount,
        remainingCount: remainingSelectors.length,
      });
      break;
    }

    const stillUnresolved: PartSelectorData[] = [];
    for (let i = 0; i < evalResult.length; i++) {
      const bbox = evalResult[i];
      const selector = remainingSelectors[i];
      if (selector === undefined) continue;
      if (bbox !== null && bbox !== undefined) {
        recovered.push(bbox);
      } else {
        stillUnresolved.push(selector);
      }
    }
    remainingSelectors = stillUnresolved;

    // If a single reload didn't recover anything, keep iterating up to the
    // budget cap (some lazy-load triggers require multiple cycles).
  }

  const reloadTotalTimeMs = Date.now() - startedAt;
  const budgetExhausted =
    remainingSelectors.length > 0 &&
    (reloadCount >= budget.maxReloadsPerPage || reloadTotalTimeMs >= budget.totalTimeoutMs);

  return { recovered, reloadCount, reloadTotalTimeMs, budgetExhausted };
}

// ============================================================================
// Helper Functions / ヘルパー関数
// ============================================================================

/**
 * パーツタイプとCSSクラスからCSSセレクタ候補を構築する
 * Build CSS selector candidates from part type and CSS classes
 *
 * 優先順位 / Priority order:
 * 1. tag.class1.class2 （最も具体的） / Most specific
 * 2. tag （タグのみ） / Tag only
 * 3. .class1.class2 （クラスのみ、タグマッピングがない場合） / Class-only when no tag mapping
 *
 * @param partType - パーツタイプ / Part type
 * @param cssClasses - CSSクラスリスト / CSS class list
 * @returns CSSセレクタ候補配列（優先度順） / CSS selector candidates (priority order)
 */
export function buildSelectorsForPart(partType: string, cssClasses: string[]): string[] {
  const tags = PART_TYPE_TO_TAGS.get(partType) ?? [];
  const selectors: string[] = [];

  // CSSクラスセレクタ文字列を構築（特殊文字をエスケープ）
  // Build CSS class selector string (escape special characters)
  const safeClasses = cssClasses
    .filter((c) => c.length > 0)
    .map((c) => `.${escapeCssIdentifier(c)}`);
  const classSelector = safeClasses.join("");

  if (tags.length > 0) {
    // タグ + クラス（最も具体的） / Tag + classes (most specific)
    if (classSelector.length > 0) {
      for (const tag of tags) {
        selectors.push(`${tag}${classSelector}`);
      }
    }
    // タグのみ（フォールバック） / Tag only (fallback)
    for (const tag of tags) {
      selectors.push(tag);
    }
  } else if (classSelector.length > 0) {
    // タグマッピングがないパーツタイプ（card, badge, cta, hero_image, tag, avatar 等）
    // Part types without tag mapping (card, badge, cta, hero_image, tag, avatar, etc.)
    selectors.push(classSelector);
  }

  return selectors;
}

/**
 * CSSセレクタ用の識別子をエスケープする
 * Escape a CSS identifier for use in selectors
 *
 * CSS.escape() がブラウザコンテキスト外では利用できないため、
 * Node.js 側でのセレクタ構築用に基本的なエスケープを行う。
 *
 * Since CSS.escape() is not available outside browser context,
 * provides basic escaping for selector construction in Node.js.
 *
 * @param identifier - エスケープ対象の識別子 / Identifier to escape
 * @returns エスケープ済み識別子 / Escaped identifier
 */
function escapeCssIdentifier(identifier: string): string {
  // CSS識別子として安全でない文字をバックスラッシュエスケープ
  // Backslash-escape characters unsafe for CSS identifiers
  return identifier.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
}
