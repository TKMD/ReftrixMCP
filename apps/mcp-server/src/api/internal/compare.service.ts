// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Internal read HTTP API — compare adapter layer (WebUI v1 W4).
 *
 * 案b (handler 直呼び / ADR-0042 Amendment 7, coherent with Decision 3 + the Amendment 5 W3a
 * precedent): a **thin adapter** that calls the existing `designCompareHandler` — it does NOT
 * re-implement any pairwise-matrix / cosine-similarity / color-palette-distance / overall-score /
 * pattern-difference orchestration nor the similarity thresholds (0.8 / 0.4) (DRY, UB-4). The
 * handler already self-contains the SearchCache + duplicate-page_id reject + `sanitizeErrorMessage`,
 * so 案b preserves every existing tool-layer gate with zero re-implementation — the service-direct
 * alternative would bypass the cache + dedup gates that physically live in the handler.
 *
 * compare differs from W3 search: it runs NO live embedding inference (the service reads
 * pre-computed `section_embeddings` + mean-pool cosine), so ADR-0043's "embedding-unavailable live
 * degradation" is structurally absent. The compare fail-loud surface is the handler's `success:false`
 * (PAGES_NOT_FOUND / INVALID_INPUT) — which this adapter passes through faithfully (honest, never a
 * fake `success:true` empty matrix; the ADR-0043 honesty principle / GDPR Art.5(1)(d) accuracy).
 *
 * CWE-209 (INV-WEBUI-COMPARE-CWE209-003): the handler already routes its own errors through
 * `sanitizeErrorMessage`; this adapter never surfaces a raw `error.message`. A defensive catch maps
 * any unexpected adapter-level throw to a sanitized `COMPARE_FAILED` shape.
 *
 * Read-only (INV-WEBUI-COMPARE-READONLY-005): this adapter performs ZERO DB writes; the POST is a
 * `page_ids`-array transport (the array cannot ride a GET query), NOT a DB mutation.
 *
 * @module api/internal/compare.service
 */

import {
  designCompareHandler,
  DESIGN_COMPARE_ERROR_CODES,
  type DesignCompareOutput,
} from "../../tools/design/compare.tool";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import type { CompareBody } from "./schemas";

/**
 * HTTP-facing compare result — the handler's `DesignCompareOutput` shape, passed through verbatim:
 * `success` / `pages[]` / `comparisons[]` (the pairwise matrix) / `common_patterns[]` /
 * `key_differences[]` / `error?`. A failure stays `success:false` with an enum-prefixed sanitized
 * `error` — never a fake success-shape (honest rendering).
 */
export type CompareResult = DesignCompareOutput;

/**
 * `POST /internal/compare` adapter — calls the shared `designCompareHandler` (案b). Maps the
 * validated boundary body to the handler input; `dimensions` / `include_details` are forwarded only
 * when present so the handler's own defaults apply when omitted. On any unexpected adapter-level
 * throw, returns a sanitized `success:false` `COMPARE_FAILED` (CWE-209) instead of leaking the raw
 * error.
 */
export async function getCompare(body: CompareBody): Promise<CompareResult> {
  try {
    return await designCompareHandler({
      page_ids: body.page_ids,
      ...(body.dimensions ? { dimensions: body.dimensions } : {}),
      ...(body.include_details !== undefined ? { include_details: body.include_details } : {}),
    });
  } catch (error: unknown) {
    // Defensive: the handler already catches + sanitizes internally, but never trust an unbounded
    // throw to escape un-sanitized (CWE-209).
    return {
      success: false,
      pages: [],
      comparisons: [],
      common_patterns: [],
      key_differences: [],
      error: `${DESIGN_COMPARE_ERROR_CODES.COMPARE_FAILED}: ${sanitizeErrorMessage(error)}`,
    };
  }
}
