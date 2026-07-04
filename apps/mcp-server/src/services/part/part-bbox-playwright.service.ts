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
import { ROBOTS_TXT, escapeCssIdentifier } from "@reftrixmcp/core";
import { validateExternalUrl } from "../../utils/url-validator";
import { logger, isDevelopment } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { getLazyScrollMaxIterations } from "../page-ingest-adapter";
import { truncateId } from "./schemas";
import { waitForRafSettle } from "./section-selector.helper";
import { TAG_TO_PART_TYPE } from "./types";

// ============================================================================
// Constants / 定数
// ============================================================================

const LOG_PREFIX = "[PartBboxPlaywright]";

/**
 * デフォルトビューポートサイズ / Default viewport size
 *
 * PR-G1 RC1: 1440×900 → 1920×1080 に統一。Phase 0 ingest (`page-ingest-adapter`
 * の `DEFAULT_VIEWPORT`) および Phase 5 part-crop の座標系と整合させ、scroll
 * sweep の絶対 Y 測定値が screenshot crop と同じ座標系で解釈されるようにする。
 *
 * Unified to 1920×1080 (was 1440×900) to match the Phase 0 ingest viewport
 * (`page-ingest-adapter` `DEFAULT_VIEWPORT`) and Phase 5 part-crop coordinate
 * system, so the scroll-sweep absolute-Y measurements are interpreted in the
 * same coordinate space as the screenshot crop.
 */
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

/**
 * ナビゲーションタイムアウト（ミリ秒） / Navigation timeout (milliseconds)
 */
const NAVIGATION_TIMEOUT_MS = 30_000;

/**
 * ナビゲーション完了後の追加待機（ミリ秒）
 * Additional wait after navigation (milliseconds)
 */
const POST_NAVIGATION_WAIT_MS = 1_000;

/**
 * PR-G1 RC1 scroll sweep: rAF 2-frame 完了待ちのタイムアウトガード（ミリ秒）。
 * Phase 0 lazy-scroll (`page-ingest-adapter` の `RAF_TIMEOUT_MS`) と同値。
 *
 * Scroll-sweep rAF 2-frame wait timeout guard (ms); same value as the Phase 0
 * lazy-scroll `RAF_TIMEOUT_MS`.
 */
const SWEEP_RAF_TIMEOUT_MS = 2_000;

/**
 * PR-G1 RC1 scroll sweep: 1 スクロール step の最小ステップ幅(px)。
 * viewportHeight が不正(NaN/0)な場合のフォールバックにも使う。
 *
 * Min scroll step (px) per sweep iteration; also used as the fallback when
 * viewportHeight is invalid (NaN / 0).
 */
const SWEEP_MIN_STEP_PX = 500;

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
  /**
   * PR-G1 RC1 (SEC-05): scroll sweep 中の lock 延長コールバック。
   * 本サービスは BullMQ `Job` を保持しないため、caller (Phase 5 dispatch /
   * Queue-based Backfill) が `extendJobLock` を bind して渡す。sweep ループの
   * 各 iteration 境界で呼ばれ、長時間 sweep による lock 失効 (dual-run / stall)
   * を防止する。省略時 (`undefined`) は no-op (既存 caller 非破壊)。
   *
   * Optional lock-extension callback invoked at each sweep iteration boundary.
   * The service holds no BullMQ `Job`, so the caller (Phase 5 dispatch /
   * Queue-based Backfill) binds `extendJobLock` and passes it here. Prevents
   * lock expiry (dual-run / stall) during a long sweep. When omitted
   * (`undefined`) it is a no-op (non-breaking for existing callers).
   *
   * 失敗は non-fatal — コールバック内で握り潰し、sweep を継続する。
   * Failures are non-fatal — swallowed inside the callback; the sweep continues.
   */
  onLockExtend?: (() => Promise<void> | void) | undefined;
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
  /**
   * section container を一意特定する安定 DOM selector (W6 Issue A PR-2 / F-M-04)。
   * 未 persist (旧データ) では undefined → gate は honest-skip (`bbox_unresolvable`)。
   * Stable DOM selector identifying the section container; undefined for legacy
   * (un-persisted) rows → the gate honest-skips (`bbox_unresolvable`).
   */
  sectionSelector?: string | undefined;
  /** CSSセレクタ候補（優先度順） / CSS selector candidates (in priority order) */
  selectors: string[];
  /**
   * セクションの絶対Y開始座標 / Section absolute Y start coordinate.
   * 後方互換のため残置 (band 削除後は gate 判定に使わないが、stored y の self-cancel
   * 計算 `Math.max(0, absoluteY - sectionStartY)` + clamp edge 判定に使用、F-L-08)。
   * Retained for backward-compat: not used for gating after band removal, but used
   * by the stored-y self-cancel computation + the clamp-edge check (F-L-08).
   */
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
// W6 Issue A PR-2 (F-M-06): pre-existing CC=30 orchestrator (browser lifecycle +
// budget + sweep + reload + cleanup branches), OUTSIDE PR-2 scope. PR-2 added only
// the additive `sectionSelectorMap` build (no new branch). Honest disable per
// Registry C-5 (no false CC guarantee); forward refactor (sub-method extraction)
// tracked, deadline 2026-06-24 (T+1d).
// eslint-disable-next-line complexity
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
  // W6 Issue A PR-2 (F-M-04): section container selector を併せて構築 (SELECT 追加不要、
  // layoutInfo は既に取得済)。bbox-resolve gate が live container scope を解決するため。
  const sectionSelectorMap = new Map<string, string | undefined>();
  for (const s of sectionPositions) {
    const info = s.layoutInfo as Record<string, unknown> | null;
    const position = info?.position as { startY?: number } | undefined;
    sectionStartYMap.set(s.id, position?.startY ?? 0);
    sectionSelectorMap.set(s.id, info?.sectionSelector as string | undefined);
  }

  // 4. パーツごとにCSSセレクタを構築
  //    Build CSS selectors for each part
  const selectorData: PartSelectorData[] = partsNeedingBbox.map((p) => ({
    id: p.id,
    sectionSelector: sectionSelectorMap.get(p.sectionPatternId),
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
      // PR-C4 D2: honest declared-bot UA に統一 (SSOT `ROBOTS_TXT.USER_AGENT` 参照、
      // hardcode 禁止)。Chrome-spoof UA を除去し ingest path (`ROBOTS_TXT.USER_AGENT`、
      // 同一 host から 200 取得済) と内部一貫させる。これは bot-evasion ではなく
      // Chrome-spoofing UA を透明な declared-bot (`+https://reftrix.dev/bot`) に置換する是正。
      // robots.txt gating は Phase 0 ingest (`isUrlAllowedByRobotsTxt`,
      // `REFTRIX_RESPECT_ROBOTS_TXT`) で実施済。本 path はその ingest 許可済 URL の
      // 同一 host re-navigation であり、ここで robots.txt を再 check しない。
      //
      // PR-C4 D2: unified to the honest declared-bot UA (referencing the SSOT
      // `ROBOTS_TXT.USER_AGENT`, no hardcode). Removes the Chrome-spoof UA for
      // internal consistency with the ingest path (which already fetched 200 from
      // the same host via `ROBOTS_TXT.USER_AGENT`). This is not bot-evasion but a
      // correction replacing the Chrome-spoofing UA with a transparent declared-bot
      // (`+https://reftrix.dev/bot`). robots.txt gating is performed in Phase 0
      // ingest; this path is a same-host re-navigation of an ingest-permitted URL,
      // so robots.txt is not re-checked here.
      userAgent: ROBOTS_TXT.USER_AGENT,
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
        // PR-C4 D2 / LCC-C2: honest ReftrixBot UA で HTTP >= 400 (403 逆転含む) の場合、
        // Chrome-spoof UA への revert は行わない (misrepresentation 復活防止)。
        // 当該パーツ群は skip (resolvedCount=0 / skippedCount=N) として扱う。
        //
        // PR-C4 D2 / LCC-C2: on HTTP >= 400 (incl. 403 reversal) with the honest
        // ReftrixBot UA, do NOT revert to the Chrome-spoof UA (prevents
        // re-introducing misrepresentation). These parts are treated as skipped.
        logger.warn(`${LOG_PREFIX} HTTP error during navigation; skipping bbox resolution`, {
          url,
          status,
          skippedCount: partsNeedingBbox.length,
        });
        return { resolvedCount: 0, skippedCount: partsNeedingBbox.length };
      }
    }

    // ページ読み込み後の待機（lazy-load, アニメーション初期化） / Post-navigation wait
    await page.waitForTimeout(POST_NAVIGATION_WAIT_MS);

    // 6. PR-G1 RC1: full-page scroll sweep で全パーツの bounding box を解決。
    //    旧実装は scrollY=0 固定で `page.evaluate` を 1 回だけ呼び、fold 下要素が
    //    viewport 外で zero-size になり除外されていた (真因 RC1)。本実装は
    //    viewportHeight step でページを sweep し、各 step で
    //    `getBoundingClientRect() + window.scrollY` の絶対 Y を測定、要素が一度でも
    //    non-zero size になればその測定値を確定する。`getLazyScrollMaxIterations()`
    //    (SEC-02 SSOT) 上限 + rAF 2-frame wait + 2s timeout guard (Phase 0
    //    lazy-scroll 同パターン)。SEC-05: 各 iteration 境界で onLockExtend。
    //
    //    PR-G1 RC1: full-page scroll sweep resolves all bounding boxes. The
    //    legacy implementation called `page.evaluate` once at scrollY=0, so
    //    fold-below elements were zero-size off-screen and excluded (RC1 root
    //    cause). This sweeps the page by viewportHeight steps, measuring the
    //    absolute Y (`getBoundingClientRect() + window.scrollY`) at each step,
    //    and confirms the first non-zero-size measurement per part.
    const resolvedBboxes = await runBboxScrollSweep({
      page,
      selectorData,
      viewportHeight: viewport.height,
      onLockExtend: params.onLockExtend,
    });

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
// W6 Issue A PR-2 (F-M-06): pre-existing CC=14 reload-pass (per-page reload + dual
// safety-budget caps + per-iteration merge), OUTSIDE PR-2 scope (untouched by
// PR-2). Honest disable per Registry C-5 (no false CC guarantee); forward refactor
// tracked, deadline 2026-06-24 (T+1d).
// eslint-disable-next-line complexity
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

    // Re-resolve only the still-unresolved subset via the SSOT page.evaluate
    // helper (TDA-01: 1st-pass / sweep / reload-pass share `runBboxPageEvaluate`,
    // eliminating the near-identical inline duplicate that previously lived
    // here). The reload pass re-measures at scrollY=0 after a fresh `page.reload`,
    // which is sufficient for the `dom_disposed` catch-all (it is a last-resort
    // recovery; the full sweep already ran in the 1st pass).
    let evalResult: Array<BboxResult | null>;
    try {
      evalResult = await runBboxPageEvaluate(page, remainingSelectors);
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
// PR-G1 RC1: SSOT page.evaluate + full-page scroll sweep
// ============================================================================

/**
 * SSOT page.evaluate helper (TDA-01).
 *
 * 1st-pass・reload-pass・scroll sweep の各 step が **本関数を共有** する。各
 * `PartSelectorData` の selector 候補を順に試し、`getBoundingClientRect()` が
 * non-zero size を返す最初の要素を sampleIndex でマッチさせ、セクション相対
 * 座標 (`absoluteY = rect.top + window.scrollY`) を返す。マッチしない part は
 * `null`。返り値は入力 `selectors` と同じ順序・長さ。
 *
 * Shared by the 1st-pass, the reload-pass, and every scroll-sweep step (TDA-01:
 * eliminates the near-identical inline `page.evaluate` duplicate). Tries each
 * `PartSelectorData`'s candidate selectors in order, matches the first
 * non-zero-size element by sampleIndex, and returns section-relative coordinates
 * (`absoluteY = rect.top + window.scrollY`). Unmatched parts return `null`. The
 * result is index-aligned with the input `selectors`.
 *
 * **Browser-context purity**: the function body runs inside `page.evaluate` and
 * MUST be self-contained (no closure over Node-side variables). Coordinate
 * math, NaN guards, etc. are performed inside the browser context.
 *
 * @internal exported for unit tests via the public service surface
 */
async function runBboxPageEvaluate(
  page: Page,
  selectors: PartSelectorData[]
): Promise<Array<BboxResult | null>> {
  // W6 Issue A PR-2 (gate-fix): the legacy ±500px proximity band is replaced by
  // DOM-ancestry containment scope. This page.evaluate body is the BROWSER-CONTEXT
  // MIRROR of the Node-context SSOT `resolvePartBboxesInScope`
  // (`section-selector.helper.ts`) — it re-declares the same semantic inline
  // because page.evaluate cannot import (closures are not serialized). Their
  // equivalence is pinned by INV-TOLERANCE-NON-GATING-001 (Layer (i) AST-pin +
  // Layer (ii) jsdom fixture against the SSOT).
  // 分解方式 (W6 Issue A `__name` 真因修正): named const helper
  // (finalize / matchInContainer / resolveOne) は esbuild keepNames が
  // `const finalize = __name((...) => {}, "finalize")` に wrap し、page.evaluate の
  // Function.prototype.toString() シリアライズで `__name(...)` が browser に混入 →
  // browser に `__name` helper 不在 → `ReferenceError: __name is not defined` →
  // sweep catch で握られ resolvedCount=0 になる真因。これを回避するため body を
  // argument-position の anonymous callback (`data.map` + `[selector].map(...)[0]`) のみ
  // で構成し named function binding を持たせない (keepNames は引数 arrow を wrap しない)。
  // 挙動は INV-TOLERANCE-NON-GATING-001 の semantic、serialize 安全性は
  // INV-PAGE-EVALUATE-NO-NAME-INJECTION-001 で pin。
  //
  // Decomposed into argument-position anonymous callbacks only (`data.map` +
  // `[selector].map(...)[0]`) so esbuild keepNames never wraps a named binding —
  // preventing the `__name(...)` serialize-injection that made `resolvedCount: 0`.
  return page.evaluate((data: PartSelectorData[]): Array<BboxResult | null> => {
    const matched = new Set<Element>();
    return data.map((part) => {
      // === resolveOne: container 解決 (null は honest-skip、document fallback / band 復帰しない) ===
      // L-8: `container` は single-assignment 必須。`if (!container) return null` の narrowing が
      // 下の `[selector].map(...)` closure へ伝播するのは再代入が無い場合のみ。再 query /
      // document-fallback で 2 度目の代入を足すと closure narrowing が破れ TS18047 になる。
      // `container` MUST stay single-assignment: the non-null narrowing propagates
      // into the nested `[selector].map(...)` closure only with no reassignment.
      if (!part.sectionSelector) return null;
      let container: Element | null;
      try {
        container = document.querySelector(part.sectionSelector);
      } catch {
        return null;
      }
      if (!container) return null;
      for (const selector of part.selectors) {
        // === matchInContainer + finalize: single-element map (`[selector].map(...)[0]`) ===
        // 1 要素配列 `[selector]` を map し selector を param に再束縛した scoped callback を作る
        // (named binding 回避)。container の non-null narrowing を closure 継承し、
        // `container.querySelectorAll(selector)` で container scope に限定する。
        // Single-element-map scoped callback: re-binds `selector` as the param to avoid
        // a named binding while inheriting `container`'s non-null narrowing.
        const hit = [selector].map((selector): BboxResult | null | undefined => {
          let elements: NodeListOf<Element>;
          try {
            elements = container.querySelectorAll(selector);
          } catch {
            return undefined; // parse-fail → 次 selector へ / invalid selector → try next candidate
          }
          let matchIndex = 0;
          for (const el of elements) {
            if (matched.has(el)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue; // zero-size skip
            if (matchIndex === part.sampleIndex) {
              // === finalize: clamp-edge honest-skip ===
              // absoluteY < sectionStartY だと stored y が 0 にクランプ → crop 絶対 y =
              // 0 + sectionStartY = garbage ゆえ null (honest-skip)。
              const absoluteY = rect.top + window.scrollY;
              if (absoluteY < part.sectionStartY) return null; // (C) honest-skip garbage crop
              matched.add(el); // clamp 判定後に add (shared `matched` Set 共有)
              return {
                id: part.id,
                x: Math.max(0, rect.left),
                y: absoluteY - part.sectionStartY, // self-cancel (absoluteY >= sectionStartY)
                width: rect.width,
                height: rect.height,
              };
            }
            matchIndex++;
          }
          // (B) population-divergent: live population (matchIndex) が sampleIndex を含まない → null。
          // それ以外 (parse 後 selector 枯渇でない undefined) は次 selector を試行。
          return matchIndex <= part.sampleIndex ? null : undefined;
        })[0];
        if (hit !== undefined) return hit;
      }
      return null;
    });
  }, selectors);
}

/** PR-G1 RC1 scroll sweep の入力パラメータ / Scroll-sweep input parameters. */
interface BboxScrollSweepParams {
  page: Page;
  selectorData: PartSelectorData[];
  /** ビューポート高さ (1 step のスクロール幅) / Viewport height (scroll step). */
  viewportHeight: number;
  /** SEC-05: lock 延長コールバック / Lock-extension callback. */
  onLockExtend?: (() => Promise<void> | void) | undefined;
}

/**
 * sweep の step 幅を finite 検証付きで決定する (SEC-01)。
 * `viewportHeight` が NaN / Infinity / <=0 の場合は `SWEEP_MIN_STEP_PX` に
 * フォールバックする (0 step による無限ループを防止)。
 *
 * Computes the sweep step size with a finite guard (SEC-01). Falls back to
 * `SWEEP_MIN_STEP_PX` when `viewportHeight` is NaN / Infinity / <= 0 (prevents
 * a 0-step infinite loop).
 *
 * @internal exported for unit tests
 */
export function computeSweepStepPx(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return SWEEP_MIN_STEP_PX;
  }
  return Math.max(SWEEP_MIN_STEP_PX, Math.floor(viewportHeight));
}

/**
 * scroll sweep の 1 step を実行する: `window.scrollTo(0, y)` → rAF 2-frame wait
 * (2s timeout guard)。Phase 0 lazy-scroll と同パターン。失敗は non-fatal。
 *
 * Executes one sweep step: `window.scrollTo(0, y)` → rAF 2-frame wait (2s
 * timeout guard). Same pattern as the Phase 0 lazy-scroll. Failures are
 * non-fatal.
 */
async function performSweepStepScroll(page: Page, y: number): Promise<void> {
  await page.evaluate((sy: number) => window.scrollTo(0, sy), y);
  // F-M-05 dedup: the rAF-race tail is shared via the `waitForRafSettle` leaf util
  // (byte-identical: same double-rAF `page.evaluate` + `page.waitForTimeout` +
  // non-fatal `.catch`). The `scrollTo` above stays inline (scroll semantics differ
  // from `scrollIntoView`, so only the rAF tail is the dedup unit). Timeout value
  // (`SWEEP_RAF_TIMEOUT_MS` = 2000) is preserved unchanged.
  await waitForRafSettle(page, SWEEP_RAF_TIMEOUT_MS);
}

/**
 * PR-G1 RC1: full-page scroll sweep で全パーツの bounding box を解決する
 * (TDA-02、単一責務 helper、CC<10)。
 *
 * 旧実装は scrollY=0 固定で 1 回だけ `page.evaluate` を呼び、fold 下要素は
 * viewport 外で zero-size になり除外されていた (真因 RC1)。本 sweep は:
 *
 *   1. `getLazyScrollMaxIterations()` (SEC-02 SSOT) を上限に viewportHeight step
 *      でページを sweep する。
 *   2. 各 step で `window.scrollTo` + rAF 2-frame wait 後、未解決 part のみを
 *      `runBboxPageEvaluate` で再測定する。
 *   3. non-zero size の測定値を確定マップに記録し、以降の step では再測定しない。
 *   4. 各 iteration 境界で `onLockExtend` を呼ぶ (SEC-05、lock 失効防止)。
 *   5. 終了後 scrollY=0 に戻し、入力順に `Array<BboxResult | null>` を返す
 *      (旧 1st-pass と同じ契約、下流コード非破壊)。
 *
 * The legacy implementation called `page.evaluate` once at scrollY=0, so
 * fold-below elements were zero-size off-screen and excluded (RC1). This sweeps
 * the page by viewportHeight steps (capped by `getLazyScrollMaxIterations()`),
 * re-measuring only still-unresolved parts at each step, confirming the first
 * non-zero-size measurement, extending the job lock per iteration (SEC-05), and
 * returning an input-order-aligned `Array<BboxResult | null>` (same contract as
 * the legacy 1st-pass).
 *
 * @internal exported indirectly via `resolvePartBoundingBoxes`
 */
async function runBboxScrollSweep(
  params: BboxScrollSweepParams
): Promise<Array<BboxResult | null>> {
  const { page, selectorData, viewportHeight, onLockExtend } = params;
  const confirmed = new Map<string, BboxResult>();
  const stepPx = computeSweepStepPx(viewportHeight);
  const maxIterations = getLazyScrollMaxIterations();

  let iteration = 0;
  let y = 0;
  let lastScrollHeight = 0;

  while (iteration < maxIterations) {
    await performSweepStepScroll(page, y);
    await extendLockSafely(onLockExtend);

    // 未解決 part のみ再測定 (確定済みは skip) / Re-measure only unresolved parts.
    const pending = selectorData.filter((p) => !confirmed.has(p.id));
    if (pending.length > 0) {
      let stepResults: Array<BboxResult | null>;
      try {
        stepResults = await runBboxPageEvaluate(page, pending);
      } catch (sweepEvalError) {
        // SEC-03: 全環境 warn + partId truncation + sanitizeErrorMessage 経由。
        // page.evaluate failure (disposed page mid-sweep) is non-fatal — keep
        // whatever was already confirmed and stop sweeping.
        logger.warn(`${LOG_PREFIX} page.evaluate() failed during scroll sweep (non-fatal)`, {
          firstPendingPartId: pending[0] ? truncateId(pending[0].id) : "(none)",
          iteration,
          error: sanitizeErrorMessage(sweepEvalError),
        });
        break;
      }
      mergeSweepStepResults(pending, stepResults, confirmed);
    }

    // ページ最下部に到達 (scrollHeight 不変 + viewport 末尾) / Reached page bottom.
    const scrollHeight = await readScrollHeight(page);
    const allConfirmed = confirmed.size >= selectorData.length;
    if (allConfirmed || (y + stepPx >= scrollHeight && scrollHeight === lastScrollHeight)) {
      break;
    }
    lastScrollHeight = scrollHeight;
    y += stepPx;
    iteration++;
  }

  // 先頭に戻す / Scroll back to top (best-effort).
  await page
    .evaluate(() => window.scrollTo(0, 0))
    .catch(() => {
      /* non-fatal */
    });

  // 入力順に整列して返す / Return aligned with input order.
  return selectorData.map((p) => confirmed.get(p.id) ?? null);
}

/**
 * sweep step の non-null 測定値を確定マップへマージする (NaN/Infinity guard 付き)。
 * SEC-01: `width`/`height` が finite かつ > 0 の測定値のみを確定する。
 * `confirmed` に既に存在する part は上書きしない (最初の non-zero 測定を採用)。
 *
 * Merges a sweep step's non-null measurements into the confirmed map with a
 * NaN/Infinity guard (SEC-01): only finite, positive-size measurements are
 * confirmed. Parts already in `confirmed` are not overwritten (first
 * non-zero measurement wins).
 */
function mergeSweepStepResults(
  pending: PartSelectorData[],
  stepResults: Array<BboxResult | null>,
  confirmed: Map<string, BboxResult>
): void {
  for (let i = 0; i < stepResults.length; i++) {
    const bbox = stepResults[i];
    const part = pending[i];
    if (part === undefined || bbox === null || bbox === undefined) continue;
    if (confirmed.has(bbox.id)) continue;
    if (!isFiniteNonZeroBbox(bbox)) continue;
    confirmed.set(bbox.id, bbox);
  }
}

/**
 * SEC-01 NaN/Infinity guard: bbox の x/y/width/height がすべて finite かつ
 * width/height が > 0 であることを検証する。`typeof === "number"` 素通りの
 * `NaN`/`Infinity` を弾く (`NaN <= 0 === false` gap)。下流の pgvector / Sharp
 * crop へ汚染値が流れることを防止する。
 *
 * SEC-01 NaN/Infinity guard: verifies bbox x/y/width/height are all finite and
 * width/height are positive. Rejects `NaN`/`Infinity` that `typeof === "number"`
 * lets through (the `NaN <= 0 === false` gap), preventing tainted values from
 * reaching the pgvector / Sharp crop downstream.
 */
function isFiniteNonZeroBbox(bbox: BboxResult): boolean {
  return (
    Number.isFinite(bbox.width) &&
    Number.isFinite(bbox.height) &&
    Number.isFinite(bbox.x) &&
    Number.isFinite(bbox.y) &&
    bbox.width > 0 &&
    bbox.height > 0
  );
}

/**
 * `document.documentElement.scrollHeight` を読み取る (失敗時 0)。
 * Reads `document.documentElement.scrollHeight` (0 on failure).
 */
async function readScrollHeight(page: Page): Promise<number> {
  try {
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    return Number.isFinite(h) && h > 0 ? h : 0;
  } catch {
    return 0;
  }
}

/**
 * SEC-05: lock 延長コールバックを安全に呼ぶ (失敗は non-fatal、握り潰す)。
 * Safely invokes the lock-extension callback (failures are non-fatal, swallowed).
 */
async function extendLockSafely(
  onLockExtend?: (() => Promise<void> | void) | undefined
): Promise<void> {
  if (!onLockExtend) return;
  try {
    await onLockExtend();
  } catch (lockError) {
    logger.warn(`${LOG_PREFIX} scroll-sweep lock extension failed (non-fatal)`, {
      error: sanitizeErrorMessage(lockError),
    });
  }
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

// W6 Issue A PR-2 (F-M-01 / SEC `019ef01e`): the previous module-private
// `escapeCssIdentifier` has been promoted to the `@reftrixmcp/core` SSOT (imported
// at the top of this file). `buildSelectorsForPart` (above) and the
// section-detector `generateSelector` both consume the single SSOT — no inline
// re-implementation. ADDENDUM A (id-token whitespace) is included in the SSOT.
