// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @reftrixmcp/core
 * Core domain logic for Reftrix
 */

export * from "./types";
export * from "./constants";
export * from "./utils";
export { logger } from "./utils/logger";
// W6 Issue A PR-2 (F-M-01, SEC `019ef01e`): CSS identifier escape SSOT. Exported
// explicitly from `./utils/css-identifier` (mirrors the `./utils/logger` pattern)
// because the file `src/utils.ts` shadows the `src/utils/` directory in Node module
// resolution, so `export * from "./utils"` reaches `utils.ts`, NOT `utils/index.ts`.
export { escapeCssIdentifier } from "./utils/css-identifier";
export * from "./services/description-generator.service";
export * from "./services/robots-txt.service";

// Config utilities (PR7e-β1)
export { loadEnvLocal } from "./config/env-local";
export type { LoadEnvLocalOptions, LoadEnvLocalResult } from "./config/env-local";

// Worker types (Plan v3 Track T4 — FailedKnownReason SSOT) /
// Worker types (Plan v3 Track T4 — FailedKnownReason SSOT)
export {
  FAILED_KNOWN_REASONS,
  failedKnownReasonForPhase,
  assertNeverFailedKnownReason,
} from "./types/failed-known-reason";
export type { FailedKnownReason } from "./types/failed-known-reason";

// Webdesign module
export * from "./webdesign";
