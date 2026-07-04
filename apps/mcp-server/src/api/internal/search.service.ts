// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Internal read HTTP API — search adapter layer (WebUI v1 W3).
 *
 * 案b (handler 直呼び / ADR-0042 Amendment 2, IO Plan Decision `019ecd27`): this module is a
 * **thin adapter** that calls the existing plain-result search HANDLERS
 * (`searchUnifiedHandler` / `designSearchByImageHandler` / `designSimilarSiteHandler`) — it does
 * NOT re-implement any RRF / facet / embedding orchestration (DRY, UB-4 / TDA-W3-P-01). The
 * handlers already self-contain the SSRF gate (`validateExternalUrl`), SearchCache, and the
 * ADR-0043 fail-loud aggregator, so 案b preserves every existing tool-layer security gate with
 * zero regression — the alternative (案a service-direct) would bypass the SSRF/cache gates that
 * physically live in the handlers.
 *
 * Fail-loud contract (ADR-0043 / INV-WEBUI-SEARCH-FAILLOUD-001): an embedding-required search
 * route returns `{ ok: false, degradedReason }` when the embedding layer is degraded — it never
 * fakes a `{ ok: true, total: 0 }` empty result. A legitimate empty result is `{ ok: true,
 * total: 0 }` (honest). The text aggregator additionally surfaces partial degradation via
 * `degradedServices[]`.
 *
 * CWE-209 / GDPR Art.5(1)(c) (INV-WEBUI-SEARCH-CWE209-005): `degradedReason` is the
 * `DegradedReason` enum ONLY. The query body, raw `error.message`, and `.so` paths are never
 * bound into the response.
 *
 * Read-only (INV-WEBUI-SEARCH-READONLY-007): every handler is read-only; the image route's POST
 * is a search-query transport (the base64 body cannot ride a GET query), NOT a DB mutation.
 *
 * @module api/internal/search.service
 */

import type { DegradedReason } from "../../services/_shared/resolve-query-embedding";
import {
  searchUnifiedHandler,
  type DegradedServiceMarker,
  type UnifiedSearchResultItem,
} from "../../tools/search-unified.tool";
import {
  designSearchByImageHandler,
  type DesignSearchResultItem,
} from "../../tools/design/search-by-image.tool";
import {
  designSimilarSiteHandler,
  type DesignSimilarSiteOutput,
} from "../../tools/design/similar-site.tool";
import type { FacetCounts } from "../../services/facet.service";
import type { TextSearchQuery, ImageSearchBody, SimilarSiteQuery } from "./schemas";

// =====================================================================================
// HTTP-facing result shapes (fail-loud, ADR-0043). `ok:false` carries an enum-only reason.
// =====================================================================================

/** Text search result (fail-loud). `ok:false` ⇒ all embedding-required services degraded. */
export type TextSearchResult =
  | {
      ok: true;
      results: UnifiedSearchResultItem[];
      total: number;
      /** Per-service partial-degradation markers (additive, ADR-0043 Decision 2). */
      degradedServices?: DegradedServiceMarker[];
      /** Facet counts (only when the caller opted in via `facets=true`). */
      facets?: FacetCounts;
    }
  | { ok: false; degradedReason: DegradedReason };

/** Image search result (fail-loud). `ok:false` ⇒ embedding unavailable/failed (NOT a fake 0). */
export type ImageSearchResult =
  | {
      ok: true;
      results: DesignSearchResultItem[];
      total: number;
      searchMode: "vision_only" | "hybrid_rrf";
    }
  | { ok: false; degradedReason: DegradedReason; code: ImageSearchFailureCode };

/** Similar-site result. `ok:false` ⇒ an input/DB error (url is DB-only, NOT an SSRF surface). */
export type SimilarSiteResult =
  | {
      ok: true;
      query_url: string;
      similar_sites: DesignSimilarSiteOutput["similar_sites"];
      total: number;
    }
  | { ok: false; reason: SimilarSiteFailureReason };

/**
 * Image-search failure classification, derived ONLY from the handler's stable error CODE prefix
 * (CWE-209: never the raw message). `service_unavailable` = embedding/DI factory unavailable;
 * `search_failed` = an embedding/search infra error (fail-loud, not a fake empty).
 */
export type ImageSearchFailureCode =
  | "service_unavailable"
  | "search_failed"
  | "invalid_input"
  | "image_rejected";

/** Similar-site failure classification (enum-only, no raw message). */
export type SimilarSiteFailureReason = "invalid_input" | "search_failed";

// =====================================================================================
// Text search — searchUnifiedHandler 直呼び (案b). RRF + facets + fail-loud aggregator 再利用。
// =====================================================================================

/** Map the section/page `view` tab to the unified search `types[]`. */
function viewToTypes(view: "section" | "page"): Array<"layout" | "part"> {
  // "section" view searches layout sections; "page" view broadens to parts as well (page-level
  // aggregation is represented by including part-level matches). Both are read-only targets.
  return view === "page" ? ["layout", "part"] : ["layout"];
}

/**
 * `GET /internal/search/text` adapter — calls the shared `searchUnifiedHandler` (RRF + facets +
 * the ADR-0043 fail-loud aggregator). On `success:false` (all embedding-required services
 * degraded) it returns `{ ok:false, degradedReason }` — NOT a fake `{ ok:true, total:0 }`.
 */
export async function getTextSearch(query: TextSearchQuery): Promise<TextSearchResult> {
  const result = await searchUnifiedHandler({
    query: query.q,
    types: viewToTypes(query.view),
    limit: query.pageSize,
    include_facets: query.facets === true,
  });

  if (!result.success) {
    // Fail-loud: the aggregator already classified all-degraded; surface the enum reason only.
    return { ok: false, degradedReason: aggregatorErrorToDegradedReason(result.error.code) };
  }

  return {
    ok: true,
    results: result.data.results,
    total: result.data.total,
    ...(result.data.degradedServices ? { degradedServices: result.data.degradedServices } : {}),
    ...(result.data.facets ? { facets: result.data.facets } : {}),
  };
}

/**
 * Map a unified aggregator error code to a `DegradedReason` (CWE-209: code only, never message).
 * The aggregator emits `SEARCH_FAILED` for all-degraded; treat any non-ok code as an active
 * embedding failure (`embedding_failed`) — the honest fail-loud signal.
 */
function aggregatorErrorToDegradedReason(_code: string): DegradedReason {
  return "embedding_failed";
}

// =====================================================================================
// Image search — designSearchByImageHandler 直呼び (案b). 既存 SSRF gate (redirect:manual) 保持。
// =====================================================================================

/**
 * `POST /internal/search/image` adapter — calls the shared `designSearchByImageHandler`. The
 * handler already gates `image_url` through `validateExternalUrl` + `redirect:"manual"`
 * (SEC-W3-H2) and caps the base64 byte size (SEC-W3-M2); this adapter only maps the validated
 * body to the handler's single `image` field. Fail-loud: a degraded embedding → `{ ok:false }`.
 */
export async function getImageSearch(body: ImageSearchBody): Promise<ImageSearchResult> {
  // The handler accepts a single `image` field (base64 or URL); the schema xor guarantees one.
  const image = body.image_base64 ?? body.image_url;
  if (!image) {
    // Defensive: the xor refine makes this unreachable, but never trust unbounded input.
    return { ok: false, degradedReason: "embedding_unavailable", code: "invalid_input" };
  }

  const result = await designSearchByImageHandler({
    image,
    ...(body.query ? { query: body.query } : {}),
    limit: body.pageSize,
  });

  if (!result.success) {
    const code = classifyImageFailureCode(result.error);
    return {
      ok: false,
      code,
      // Fail-loud reason: unavailable factory vs. an active embedding/search failure.
      degradedReason: code === "service_unavailable" ? "embedding_unavailable" : "embedding_failed",
    };
  }

  return {
    ok: true,
    results: result.results,
    total: result.total,
    searchMode: result.searchMode,
  };
}

/**
 * Classify the image handler's error STRING (which is prefixed with a stable `CODE: message`)
 * into an `ImageSearchFailureCode` using the code prefix ONLY (CWE-209: the raw message is never
 * inspected for content, only the leading enum token is matched).
 */
function classifyImageFailureCode(error: string | undefined): ImageSearchFailureCode {
  const code = (error ?? "").split(":")[0]?.trim() ?? "";
  if (code === "SERVICE_UNAVAILABLE") return "service_unavailable";
  if (code === "INVALID_INPUT") return "invalid_input";
  if (code === "SSRF_BLOCKED" || code === "IMAGE_FETCH_FAILED" || code === "IMAGE_DECODE_FAILED") {
    return "image_rejected";
  }
  // EMBEDDING_FAILED / SEARCH_FAILED / INTERNAL_ERROR / unknown → active failure (fail-loud).
  return "search_failed";
}

// =====================================================================================
// Similar-site — designSimilarSiteHandler 直呼び (案b). 既存 URL 入力検証 gate (:129) を保持。
// =====================================================================================

/**
 * `GET /internal/search/similar-site` adapter — calls the shared `designSimilarSiteHandler`,
 * which validates the `url` input via `validateExternalUrl` (SEC-W3-H1: 案b preserves the
 * existing tool-layer URL-input gate; similar-site is DB-only — input-validation, NOT a fetch
 * SSRF surface, LCC-W3-W1). An empty `similar_sites` array is an honest "類似なし" (not fake).
 */
export async function getSimilarSiteSearch(query: SimilarSiteQuery): Promise<SimilarSiteResult> {
  const result = await designSimilarSiteHandler({
    url: query.url,
    limit: query.pageSize,
  });

  if (!result.success) {
    return { ok: false, reason: classifySimilarSiteFailure(result.error) };
  }

  return {
    ok: true,
    query_url: result.query_url,
    similar_sites: result.similar_sites,
    total: result.total,
  };
}

/**
 * Classify the similar-site handler's error STRING into an enum reason using the code prefix
 * ONLY (CWE-209). `INVALID_INPUT` = url-input validation rejection; everything else = search.
 */
function classifySimilarSiteFailure(error: string | undefined): SimilarSiteFailureReason {
  const code = (error ?? "").split(":")[0]?.trim() ?? "";
  return code === "INVALID_INPUT" ? "invalid_input" : "search_failed";
}
