// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Internal read HTTP API — rate-limit express adapter (WebUI v1 W3, SEC-W3-M1).
 *
 * Closes CWE-770 at the internal-API HTTP boundary by reusing the EXISTING Token Bucket core
 * (`RateLimiter` — Redis Lua + in-memory graceful fallback + NaN/Infinity defense) that already
 * governs the MCP tool path. This is a THIN express adapter (DRY, UB-4): it does NOT re-implement
 * the bucket / Lua / fallback — it calls `RateLimiter.checkRateLimit(<routeKey>)` with the W3
 * route keys (`internal_search.*`, mapped to the `search` tier in `TOOL_TIER_MAP`). The MCP tool
 * path and the HTTP route path therefore share ONE rate-limit core + ONE Redis Lua script.
 *
 * Contract:
 * - Allowed → `next()`, with `X-RateLimit-Limit` / `X-RateLimit-Remaining` headers (observability).
 * - Exceeded → fail-loud HTTP 429 + `Retry-After` (seconds) + a FIXED JSON message. The body is a
 *   fixed literal (CWE-209: no raw error, no query body, no rate-limit internals) — matching the
 *   W1/W2 idiom of fixed-string 400/404 bodies. The limiter error path still uses
 *   `sanitizeErrorMessage` for server-side logging.
 * - Graceful degradation: a Redis outage is handled INSIDE the core (in-memory fallback); the
 *   adapter never throws on a limiter error — it fails OPEN (allows the request) and logs, so a
 *   limiter fault cannot take down the read API (availability > strict limiting for a dogfood
 *   localhost surface).
 * - Disabled: when `RATE_LIMIT_ENABLED=false`, the core returns `allowed:true` (no-op pass-through).
 *
 * @module api/internal/rate-limit-middleware
 */

import type { Request, Response, NextFunction } from "express";
import { getRateLimiter } from "../../middleware/rate-limiter";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { logger } from "../../utils/logger";

/**
 * Build an express middleware that rate-limits a route via the shared Token Bucket core.
 *
 * @param routeKey - a `TOOL_TIER_MAP` key (e.g. `"internal_search.text"`); its tier selects the
 *   RPM. Unknown keys fall back to the `default` tier inside the core (never unbounded).
 */
export function internalRateLimit(
  routeKey: string
): (req: Request, res: Response, next: NextFunction) => void {
  return (_req: Request, res: Response, next: NextFunction): void => {
    void enforceRateLimit(routeKey, res, next);
  };
}

/** Async core of the middleware (kept separate so the returned fn stays sync-shaped). */
async function enforceRateLimit(
  routeKey: string,
  res: Response,
  next: NextFunction
): Promise<void> {
  let result;
  try {
    result = await getRateLimiter().checkRateLimit(routeKey);
  } catch (error: unknown) {
    // Fail-open on a limiter fault (the core already falls back to in-memory on Redis outage;
    // this catch only triggers on an unexpected limiter bug). Availability > strict limiting.
    logger.warn("[InternalAPI] rate limiter error — failing open", {
      error: sanitizeErrorMessage(error),
      routeKey,
    });
    next();
    return;
  }

  // Observability headers (always set, both allowed and denied).
  res.setHeader("X-RateLimit-Limit", String(result.limit));
  res.setHeader("X-RateLimit-Remaining", String(result.remaining));

  if (result.allowed) {
    next();
    return;
  }

  // Exceeded → fail-loud 429 (CWE-770). Fixed literal message (CWE-209: no raw error / no query
  // body / no rate-limit internals leaked). `Retry-After` is a coarse seconds hint only.
  const retryAfterSeconds = Math.ceil((result.retryAfterMs ?? 60_000) / 1000);
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(429).json({ error: "Too many requests" });
}
