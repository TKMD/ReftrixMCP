// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Quality Tool — re-export façade
 *
 * PR-V3-T1a Phase 2 Step 5 disambiguates the historical naming drift between
 * `tools/embedding-quality.tool.ts` (cited in T1a design / registry / audits)
 * and the actual canonical location `tools/embedding/quality.tool.ts`.
 * This file is a thin re-export façade so historical citations continue to
 * resolve while the canonical SSOT remains the original location.
 *
 * Re-export façade so historical T1a citations of
 * `tools/embedding-quality.tool.ts` resolve to the canonical
 * `tools/embedding/quality.tool.ts`.
 *
 * @see tools/embedding/quality.tool.ts (canonical implementation)
 *
 * @module tools/embedding-quality.tool
 */

export * from "./embedding/quality.tool";
