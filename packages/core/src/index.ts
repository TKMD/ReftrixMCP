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
export * from "./services/description-generator.service";
export * from "./services/robots-txt.service";

// Config utilities (PR7e-β1)
export { loadEnvLocal } from "./config/env-local";
export type { LoadEnvLocalOptions, LoadEnvLocalResult } from "./config/env-local";

// Webdesign module
export * from "./webdesign";
