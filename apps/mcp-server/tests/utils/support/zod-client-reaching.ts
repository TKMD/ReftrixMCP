// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The audited sets of places that put zod messages in front of a client. Single source for the
 * rawjoin snapshot test and for the validator coverage test (same scope for both).
 */

/** Client-reaching sites that join `e.message` of a ZodError: file -> number of call sites. */
export const CLIENT_REACHING_MESSAGE_JOIN_SITES: Readonly<Record<string, number>> = {
  "src/tools/audit/query.tool.ts": 1,
  "src/tools/background/search.tool.ts": 1,
  "src/tools/data/data.tool.ts": 2,
  "src/tools/design/compare.tool.ts": 1,
  "src/tools/design/regression-test.tool.ts": 1,
  "src/tools/design/search-by-image.tool.ts": 1,
  "src/tools/design/similar-site.tool.ts": 1,
  "src/tools/design/track-changes.tool.ts": 1,
  "src/tools/embedding/quality.tool.ts": 1,
  "src/tools/layout/search.tool.ts": 1,
  "src/tools/layout/to-code.tool.ts": 1,
  "src/tools/narrative/analyze.tool.ts": 1,
  "src/tools/narrative/search.tool.ts": 1,
  "src/tools/part/compare.tool.ts": 1,
  "src/tools/part/inspect.tool.ts": 1,
  "src/tools/part/search.tool.ts": 1,
  "src/tools/preference/get.tool.ts": 1,
  "src/tools/preference/hear.tool.ts": 1,
  "src/tools/preference/reset.tool.ts": 1,
  "src/tools/report/generate.tool.ts": 1,
  "src/tools/responsive/capture.tool.ts": 1,
  "src/tools/responsive/search.tool.ts": 1,
  "src/tools/section/inspect.tool.ts": 1,
  "src/tools/style-get-palette.ts": 1,
};

/** Same join expression, but the text never reaches the client (log only / startup). */
export const NOT_CLIENT_REACHING_MESSAGE_JOIN_SITES: Readonly<Record<string, string>> = {
  "src/tools/motion/analyze-frames.handler.ts":
    "logger.warn only; client receives a fixed 'Invalid input parameters'",
  "src/config/phase5-config.ts": "startup config warning (logger)",
  "src/config/redis.ts": "startup env warning (logger)",
  "src/services/vision/scroll-vision.analyzer.ts": "internal vision response check (logger)",
  "src/utils/error-messages.ts":
    "the converter's own loops over the issues (for-of, extractDetailedError, the hints map); covered by 4a golden, not by this join set",
};

/** Sites per excluded file when it is not 1 (the scan counts for-of and named callbacks too). */
export const NOT_CLIENT_REACHING_SITE_COUNTS: Readonly<Record<string, number>> = {
  "src/utils/error-messages.ts": 3,
};

/**
 * Files that reference formatZodError (details.received / message reach the client through these
 * 5 tools). Found by scanFormatZodErrorCallers (AST: calls, aliases, namespace access, re-exports).
 */
export const FORMAT_ZOD_ERROR_CALLERS: readonly string[] = [
  "src/tools/accessibility/audit.tool.ts",
  "src/tools/layout/batch-ingest.tool.ts",
  "src/tools/layout/ingest.tool.ts",
  "src/tools/motion/detect.tool.ts",
  "src/tools/quality/evaluate.tool.ts",
];
