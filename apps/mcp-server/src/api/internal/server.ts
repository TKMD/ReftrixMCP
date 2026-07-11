// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Internal read HTTP API server (WebUI v1 W1, O-1 Option A — ADR-0042 Decision 1).
 *
 * The WebUI proxies its ML-/DB-backed reads through this internal HTTP surface instead
 * of importing `packages/ml` directly (avoids OOM/VRAM lifecycle double-implementation
 * in the resident Next.js process). This file is the **HTTP server surface** (bootstrap
 * + lifecycle + error middleware) re-using the existing `express` dependency.
 *
 * Security contract (ADR-0042 Decision 2 / UB-4):
 * - Binds 127.0.0.1 ONLY (0.0.0.0 forbidden — inherits the `bull-board.ts:179` precedent).
 * - Every /internal route passes through a single auth middleware seam
 *   (`internalAuthSeam`) — the structural insertion point for future auth/rate-limit.
 * - All errors route through `sanitizeErrorMessage()` (CWE-209 / L-05): no raw
 *   error.message in the HTTP response body.
 * - Zod input bounds (UB-3) reject malformed input with HTTP 400.
 *
 * DRY (UB-4): route handlers call the shared `dashboard.service` directly, NOT the MCP
 * tool layer.
 *
 * @module api/internal/server
 */

import express, { type Express, type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { logger } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { getDashboardStats, getRecentPages, getFeaturedComparison } from "./dashboard.service";
import {
  getPageDetail,
  getPageQuality,
  getPageSections,
  getPageParts,
  getPageNarrative,
  getSimilarDesigns,
  getScreenshotStream,
  getCropStream,
} from "./page-detail.service";
import {
  pagesQuerySchema,
  partsQuerySchema,
  similarQuerySchema,
  webPageIdParamSchema,
  cropParamsSchema,
  textSearchQuerySchema,
  imageSearchBodySchema,
  similarSiteQuerySchema,
  compareBodySchema,
  featuredComparisonQuerySchema,
  galleryQuerySchema,
  MAX_BASE64_CHARS,
  MAX_COMPARE_BODY_BYTES,
} from "./schemas";
import { getTextSearch, getImageSearch, getSimilarSiteSearch } from "./search.service";
import { getCompare } from "./compare.service";
import { getGallerySections } from "./gallery.service";
import { internalRateLimit } from "./rate-limit-middleware";

/** Default internal API port (offset 21000 from a base 3006 → 24006). */
export const INTERNAL_API_PORT = 24006;

/** Options for starting the internal API server. */
export interface InternalApiOptions {
  /** Listen port (0 = ephemeral, used by tests). Defaults to INTERNAL_API_PORT. */
  port?: number;
}

/**
 * Single auth middleware seam (ADR-0042 Decision 2 (b)).
 *
 * In dogfood (localhost single-user) there is no auth, so this is a structural pass-through.
 * It is the ONE place every /internal route flows through, so a future auth check can be
 * inserted here without touching individual routes. SEC audits verify "seam exists + all
 * routes pass through it".
 */
export function internalAuthSeam(_req: Request, _res: Response, next: NextFunction): void {
  // Dogfood: no auth. Future auth/rate-limit insertion point (single seam).
  next();
}

/** GET /internal/dashboard/stats — read-only aggregated dashboard stats. */
async function handleDashboardStats(_req: Request, res: Response): Promise<void> {
  const stats = await getDashboardStats();
  res.json(stats);
}

/**
 * GET /internal/dashboard/featured-comparison?seed=&limit= — read-only "注目の比較" payload
 * (W4 dashboard redesign). Returns `{ seed, similar }`; `seed: null` + `similar: []` is an honest
 * empty (no embedding-bearing page / seed not found), NOT a fake comparison. Zero ML (pgvector KNN).
 */
async function handleFeaturedComparison(req: Request, res: Response): Promise<void> {
  const parsed = featuredComparisonQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters" });
    return;
  }
  const result = await getFeaturedComparison(parsed.data.seed, parsed.data.limit);
  res.json(result);
}

/** GET /internal/pages — read-only recent pages, Zod-bounded (page/pageSize). */
async function handlePages(req: Request, res: Response): Promise<void> {
  const parsed = pagesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters" });
    return;
  }
  const pages = await getRecentPages(parsed.data.pageSize);
  res.json({ page: parsed.data.page, pageSize: parsed.data.pageSize, pages });
}

/** GET /internal/pages/:webPageId — page detail (meta + counts + hasScreenshot). 404 on miss. */
async function handlePageDetail(req: Request, res: Response): Promise<void> {
  const parsed = webPageIdParamSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid path parameters" });
    return;
  }
  const detail = await getPageDetail(parsed.data.webPageId);
  if (!detail) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(detail);
}

/** GET /internal/pages/:webPageId/quality — latest quality eval, or null (graceful 未評価). */
async function handlePageQuality(req: Request, res: Response): Promise<void> {
  const parsed = webPageIdParamSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid path parameters" });
    return;
  }
  const quality = await getPageQuality(parsed.data.webPageId);
  res.json(quality);
}

/**
 * GET /internal/pages/:webPageId/narrative — human-meaningful design narrative, or null body
 * (graceful "未分析"; null is NOT a 404 — the page exists but has no narrative).
 */
async function handlePageNarrative(req: Request, res: Response): Promise<void> {
  const parsed = webPageIdParamSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid path parameters" });
    return;
  }
  const narrative = await getPageNarrative(parsed.data.webPageId);
  res.json(narrative);
}

/**
 * GET /internal/pages/:webPageId/similar?limit=N — read-only pgvector nearest-neighbor similar
 * designs (zero ML). Returns `{ items }`; an empty array is an honest "類似なし" (NOT a fake
 * success). `limit` is Zod-bounded to 1..12 (CWE-770); a bad limit → 400 fixed string.
 */
async function handlePageSimilar(req: Request, res: Response): Promise<void> {
  const params = webPageIdParamSchema.safeParse(req.params);
  const query = similarQuerySchema.safeParse(req.query);
  if (!params.success || !query.success) {
    res.status(400).json({ error: "Invalid request parameters" });
    return;
  }
  const items = await getSimilarDesigns(params.data.webPageId, query.data.limit);
  res.json({ items });
}

/** GET /internal/pages/:webPageId/sections — paginated sections (section-linked PII redact). */
async function handlePageSections(req: Request, res: Response): Promise<void> {
  const params = webPageIdParamSchema.safeParse(req.params);
  const query = pagesQuerySchema.safeParse(req.query);
  if (!params.success || !query.success) {
    res.status(400).json({ error: "Invalid request parameters" });
    return;
  }
  const result = await getPageSections(params.data.webPageId, query.data.page, query.data.pageSize);
  res.json(result);
}

/** GET /internal/pages/:webPageId/parts — paginated parts (high-PII redact + partType filter). */
async function handlePageParts(req: Request, res: Response): Promise<void> {
  const params = webPageIdParamSchema.safeParse(req.params);
  const query = partsQuerySchema.safeParse(req.query);
  if (!params.success || !query.success) {
    res.status(400).json({ error: "Invalid request parameters" });
    return;
  }
  const result = await getPageParts(
    params.data.webPageId,
    query.data.page,
    query.data.pageSize,
    query.data.partType
  );
  res.json(result);
}

/**
 * GET /internal/pages/:webPageId/screenshot — stream the persisted full-page screenshot
 * (WebUI v1 W2 rework — ADR-0042 Amendment 3; full-screenshot serve, no per-section crop).
 *
 * ROUTE-LOCAL error path (TPA-W2RW-M-01 / INV-WEBUI-SCREENSHOT-002): this binary image route
 * must NEVER be corrupted by the shared `errorMiddleware`'s `res.status(500).json(...)`. So all
 * error outcomes are **status-only with no body** here:
 *   - invalid webPageId param → 400 `.end()` (no JSON).
 *   - missing / stale / escaped / symlink → `getScreenshotStream` null → 404 `.end()` (no JSON).
 * Success only: pin `Content-Type: image/png` + `X-Content-Type-Options: nosniff` (INV-003) +
 * `Content-Length`, then `stream.pipe(res)`. A mid-stream read error is logged server-side and
 * the response is ended without a JSON body (the stream is destroyed). This handler resolves its
 * own outcomes and is intentionally NOT wrapped by `asyncRoute` (so it never reaches the shared
 * JSON 500 middleware); a top-level rejection is caught and mapped to a status-only 500.
 *
 * GET /internal/pages/:webPageId/screenshot — 永続フルページスクリーンショットを stream 配信。
 * バイナリ画像ルートが共有 errorMiddleware の JSON 500 で汚染されないよう、エラーは全て
 * status-only (body なし): param 不正→400 / null→404。成功時のみ content-type 固定 + nosniff +
 * Content-Length を付与し pipe する。stream 途中エラーはサーバ側ログ + body なしで終了する。
 */
async function handlePageScreenshot(req: Request, res: Response): Promise<void> {
  const parsed = webPageIdParamSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).end();
    return;
  }

  const result = await getScreenshotStream(parsed.data.webPageId);
  if (result === null) {
    res.status(404).end();
    return;
  }

  res.status(200);
  res.type("image/png");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Length", String(result.bytes));

  // Mid-stream error: log + end without a JSON body (route-local, NOT the shared 500-JSON path).
  result.stream.on("error", (streamErr: unknown) => {
    logger.error("[InternalAPI] screenshot stream failed mid-flight", {
      error: streamErr instanceof Error ? streamErr.message : String(streamErr),
    });
    result.stream.destroy();
    res.end();
  });
  result.stream.pipe(res);
}

/**
 * GET /internal/pages/:webPageId/crops/:kind/:entityId — stream a persisted per-section /
 * per-part crop (W6 Issue A PR-4a — ADR-0042 Amendment 12). A structural clone of
 * `handlePageScreenshot`: binary-safe, ROUTE-LOCAL status-only error path (this binary image
 * route must NEVER be corrupted by the shared `errorMiddleware`'s `res.status(500).json(...)`).
 * All error outcomes are status-only with no body (F-M-04 / SEC-M-01):
 *   - invalid params (non-UUID page/entity, bad kind enum) → 400 `.end()` (no JSON).
 *   - missing / NULL crop_storage_path (incl. high-PII serve-time redaction) / stale / escaped
 *     / symlink → `getCropStream` null → 404 `.end()` (no JSON).
 * Success only: pin `Content-Type image/png` + `X-Content-Type-Options nosniff` + `Content-Length`,
 * then `stream.pipe(res)`. Intentionally NOT wrapped by `asyncRoute` (a top-level rejection is
 * mapped to a status-only 500 by `cropRoute`, never the shared JSON 500 middleware).
 *
 * バイナリ crop 配信ルート。共有 errorMiddleware の JSON 500 で汚染されないよう、エラーは全て
 * status-only (body なし): param 不正→400 / null (不在 / NULL / high-PII redaction / symlink)→404。
 */
async function handlePageCrop(req: Request, res: Response): Promise<void> {
  const parsed = cropParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).end();
    return;
  }

  const result = await getCropStream(parsed.data.webPageId, parsed.data.kind, parsed.data.entityId);
  if (result === null) {
    res.status(404).end();
    return;
  }

  res.status(200);
  res.type("image/png");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Length", String(result.bytes));

  // Mid-stream error: log + end without a JSON body (route-local, NOT the shared 500-JSON path).
  result.stream.on("error", (streamErr: unknown) => {
    logger.error("[InternalAPI] crop stream failed mid-flight", {
      error: streamErr instanceof Error ? streamErr.message : String(streamErr),
    });
    result.stream.destroy();
    res.end();
  });
  result.stream.pipe(res);
}

// =====================================================================================
// W3 search routes (ADR-0042 Amendment 2 / ADR-0043 fail-loud). 案b = the adapter calls the
// shared search HANDLERS (search.service.ts), preserving every tool-layer security gate.
// =====================================================================================

/**
 * GET /internal/search/text?q=... — text semantic search (RRF + facets, fail-loud). On a
 * degraded embedding layer the body is `{ ok:false, degradedReason }` — never a fake empty.
 */
async function handleTextSearch(req: Request, res: Response): Promise<void> {
  const parsed = textSearchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters" });
    return;
  }
  const result = await getTextSearch(parsed.data);
  // Fail-loud (ADR-0043): a degraded embedding layer is HTTP 503, not a 200 with a fake 0.
  res.status(result.ok ? 200 : 503).json(result);
}

/**
 * POST /internal/search/image — image-to-design search (DINOv2 + HNSW vision + RRF, fail-loud).
 * `express.json` is scoped to THIS route only (the W1/W2 GET routes never carry a body parser).
 */
async function handleImageSearch(req: Request, res: Response): Promise<void> {
  const parsed = imageSearchBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const result = await getImageSearch(parsed.data);
  res.status(result.ok ? 200 : 503).json(result);
}

/**
 * GET /internal/search/similar-site?url=... — similar-site search (mean pooling + HNSW +
 * self-exclusion). `url` is DB-only input-validation (NOT a fetch SSRF surface); the handler
 * routes it through `validateExternalUrl` (案b preserves the tool-layer URL-input gate).
 */
async function handleSimilarSiteSearch(req: Request, res: Response): Promise<void> {
  const parsed = similarSiteQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters" });
    return;
  }
  const result = await getSimilarSiteSearch(parsed.data);
  // An invalid URL input is a 400 (client error); a search infra failure is a 503 (fail-loud).
  if (!result.ok) {
    res.status(result.reason === "invalid_input" ? 400 : 503).json(result);
    return;
  }
  res.status(200).json(result);
}

// =====================================================================================
// W4 compare route (ADR-0042 Amendment 7). 案b = designCompareHandler 直呼び adapter. compare runs
// NO live embedding inference (DB pre-computed read), so ADR-0043's live degradation is structurally
// absent; the fail-loud surface is the handler's success:false (PAGES_NOT_FOUND / INVALID_INPUT).
// =====================================================================================

/**
 * Map a compare `success:false` error-code PREFIX to an HTTP status (CWE-209: the leading enum token
 * only, never the raw message). PAGES_NOT_FOUND → 404 (referenced page(s) absent); INVALID_INPUT →
 * 400 (duplicate page_ids — the boundary array bounds passed, the handler `Set`-rejected); anything
 * else (COMPARE_FAILED / SERVICE_UNAVAILABLE / INSUFFICIENT_DATA) → 503 (fail-loud infra/data).
 */
function compareFailureStatus(error: string | undefined): number {
  const code = (error ?? "").split(":")[0]?.trim() ?? "";
  if (code === "PAGES_NOT_FOUND") return 404;
  if (code === "INVALID_INPUT") return 400;
  return 503;
}

/**
 * POST /internal/compare — multi-dimensional design comparison (2-5 pages, read-only). A malformed
 * body is a 400 fixed string (CWE-209: no Zod issue leak). The structured `DesignCompareOutput` body
 * is ALWAYS returned (the webui renders the honest `error` reason); on `success:false` the HTTP
 * status reflects the failure class — never a fake empty matrix (honest fail-loud).
 */
async function handleCompare(req: Request, res: Response): Promise<void> {
  const parsed = compareBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const result = await getCompare(parsed.data);
  res.status(result.success ? 200 : compareFailureStatus(result.error)).json(result);
}

/**
 * GET /internal/sections?type=&scope=&page=&pageSize= — cross-page section gallery listing
 * (W7c-api, ADR-0042 Amendment 13; `scope` + `facets` additive in W7c-api-2). 母集団 = crop-bearing
 * sections (`crop_storage_path IS NOT NULL`); the optional `type` narrows by sectionType (allowlist
 * Zod-validated), and `scope="content"` (default `"all"`) excludes chrome types when no explicit
 * `type` is given (an explicit `type` always wins). Returns `{ page, pageSize, total, items, facets }`;
 * an empty `items` is honest (no crop-bearing section matches), never a fake. high-PII sections are
 * excluded by the 3-layer PII belt (structural + count/items-symmetric READ-sink, applied to facets
 * too). A malformed query → 400 fixed string (CWE-209: no Zod issue leak). This is a LISTING only —
 * crop bytes reuse the existing serve route (`INV-CROP-SERVE-PII-REDACTION-001` unchanged).
 */
async function handleGallerySections(req: Request, res: Response): Promise<void> {
  const parsed = galleryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters" });
    return;
  }
  const result = await getGallerySections(
    parsed.data.page,
    parsed.data.pageSize,
    parsed.data.type,
    parsed.data.scope
  );
  res.json(result);
}

/**
 * Route wrapper for the binary screenshot handler: maps an unexpected top-level rejection to a
 * status-only 500 (no JSON body) instead of the shared `errorMiddleware` JSON path.
 */
function screenshotRoute(req: Request, res: Response): void {
  handlePageScreenshot(req, res).catch((err: unknown) => {
    logger.error("[InternalAPI] screenshot route failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.end();
    }
  });
}

/**
 * Route wrapper for the binary crop handler: maps an unexpected top-level rejection to a
 * status-only 500 (no JSON body) instead of the shared `errorMiddleware` JSON path
 * (W6 Issue A PR-4a, mirrors `screenshotRoute`).
 */
function cropRoute(req: Request, res: Response): void {
  handlePageCrop(req, res).catch((err: unknown) => {
    logger.error("[InternalAPI] crop route failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.end();
    }
  });
}

/** Wrap an async handler so rejections reach the error middleware. */
function asyncRoute(
  fn: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/**
 * Error middleware (CWE-209 / L-05): route every error through `sanitizeErrorMessage`.
 * The raw error is logged server-side; the client receives only a generic message.
 */
function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  logger.error("[InternalAPI] request failed", {
    error: err instanceof Error ? err.message : String(err),
  });
  res.status(500).json({ error: sanitizeErrorMessage(err) });
}

/**
 * Build the express app exposing the W1 read-only /internal routes.
 * Mounting order: auth seam → routes → error middleware.
 */
export function createInternalApiApp(): Express {
  const app = express();

  // Single auth middleware seam on every /internal route (ADR-0042 Decision 2 (b)).
  app.use("/internal", internalAuthSeam);

  app.get("/internal/dashboard/stats", asyncRoute(handleDashboardStats));
  // W4 dashboard redesign: read-only "注目の比較" (zero ML, pgvector KNN; honest empty allowed).
  app.get("/internal/dashboard/featured-comparison", asyncRoute(handleFeaturedComparison));
  app.get("/internal/pages", asyncRoute(handlePages));

  // W2 page-detail read routes (ADR-0042 Amendment 1 §A1.1). Order: the more specific
  // sub-paths (/quality, /sections, /parts) and the detail route all carry an extra
  // segment, so they never collide with the exact `/internal/pages` listing above.
  app.get("/internal/pages/:webPageId", asyncRoute(handlePageDetail));
  app.get("/internal/pages/:webPageId/quality", asyncRoute(handlePageQuality));
  app.get("/internal/pages/:webPageId/sections", asyncRoute(handlePageSections));
  app.get("/internal/pages/:webPageId/parts", asyncRoute(handlePageParts));

  // W2 human-value rework (ADR-0042 Amendment 4): human-meaningful read routes. `/narrative`
  // returns null body for an un-analyzed page (graceful, not 404); `/similar` returns `{ items }`
  // from a read-only pgvector nearest-neighbor query (zero ML, an empty array is honest "類似なし").
  app.get("/internal/pages/:webPageId/narrative", asyncRoute(handlePageNarrative));
  app.get("/internal/pages/:webPageId/similar", asyncRoute(handlePageSimilar));

  // W2 rework: binary full-screenshot serve (ADR-0042 Amendment 3). NOT wrapped by asyncRoute —
  // it has a route-local status-only error path so the shared JSON 500 middleware never corrupts
  // the image response (INV-WEBUI-SCREENSHOT-002 / TPA-W2RW-M-01).
  app.get("/internal/pages/:webPageId/screenshot", screenshotRoute);

  // W6 Issue A PR-4a: binary per-section / per-part crop serve (ADR-0042 Amendment 12). NOT
  // wrapped by asyncRoute — it has a route-local status-only error path (cropRoute) so the
  // shared JSON 500 middleware never corrupts the image response (F-M-04 / SEC-M-01). The
  // `:kind` segment is an enum-validated param (section | part), so it never collides with
  // the `/screenshot` / `/sections` / `/parts` sub-paths above (distinct extra `:entityId`).
  app.get("/internal/pages/:webPageId/crops/:kind/:entityId", cropRoute);

  // W3 search routes (ADR-0042 Amendment 2 / ADR-0043). 案b = handler 直呼び adapter.
  // SEC-W3-M1 (CWE-770): each search route is rate-limited via the shared Token Bucket core
  // (`internalRateLimit` adapter → `RateLimiter.checkRateLimit` → same Redis Lua + in-memory
  // fallback as the MCP tool path). The limiter runs AFTER the auth seam and BEFORE the
  // handler/body-parser, so an over-limit request is rejected (429) before any embedding/DB
  // work or large-body parsing. text / similar-site are GET (no body parser); image is POST with
  // a route-scoped `express.json({ limit })` placed AFTER the limiter (parse only if allowed).
  app.get(
    "/internal/search/text",
    internalRateLimit("internal_search.text"),
    asyncRoute(handleTextSearch)
  );
  app.post(
    "/internal/search/image",
    internalRateLimit("internal_search.image"),
    // limit = base64 char cap + ~1KB JSON envelope (keys/quotes/page params); bytes string.
    express.json({ limit: MAX_BASE64_CHARS + 1024 }),
    asyncRoute(handleImageSearch)
  );
  app.get(
    "/internal/search/similar-site",
    internalRateLimit("internal_search.similar_site"),
    asyncRoute(handleSimilarSiteSearch)
  );

  // W4 compare route (ADR-0042 Amendment 7). 案b = designCompareHandler 直呼び adapter.
  // F-PLAN-W4-B (CWE-770): rate-limited via the shared Token Bucket core at the `search` tier (like
  // the search routes). The limiter runs BEFORE the route-scoped `express.json` so an over-limit
  // request is rejected (429) before body parsing / DB work. compare is read-only (page_ids
  // transport, no DB write); a PAGES_NOT_FOUND stays success:false (honest), never a fake matrix.
  app.post(
    "/internal/compare",
    internalRateLimit("internal_compare"),
    express.json({ limit: MAX_COMPARE_BODY_BYTES }),
    asyncRoute(handleCompare)
  );

  // W7c-api gallery route (ADR-0042 Amendment 13): cross-page section gallery listing. Like the
  // search/compare routes it is a search-class read, so it is rate-limited via the SAME shared
  // Token Bucket core + Redis Lua at the `search` tier (condition 9 / CWE-770 DoS prevention). GET
  // (no body parser); the limiter runs AFTER the auth seam and BEFORE the handler, so an over-limit
  // request is rejected (429) before any DB work. `/internal/sections` is a distinct top-level path
  // (never collides with `/internal/pages/:webPageId/sections`, which carries extra segments).
  app.get(
    "/internal/sections",
    internalRateLimit("internal_sections"),
    asyncRoute(handleGallerySections)
  );

  app.use(errorMiddleware);
  return app;
}

/**
 * Start the internal API server bound to 127.0.0.1 ONLY (ADR-0042 Decision 2 (a)).
 * Returns the http.Server, or null on bootstrap failure (graceful degradation).
 */
export async function startInternalApi(options: InternalApiOptions = {}): Promise<Server | null> {
  try {
    const app = createInternalApiApp();
    const port = options.port ?? INTERNAL_API_PORT;
    return await new Promise<Server>((resolve) => {
      // localhost only — 0.0.0.0 forbidden (inherits bull-board.ts:179 precedent).
      const server = app.listen(port, "127.0.0.1", () => {
        logger.info(`[InternalAPI] read API started at http://127.0.0.1:${port}/internal`);
        resolve(server);
      });
    });
  } catch (error: unknown) {
    logger.error("[InternalAPI] Failed to start internal read API", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
