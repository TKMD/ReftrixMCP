// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FailedKnownReason Zod Schema Mirror — Plan v3 Track T4 (PR-V3-T4).
 *
 * 4-layer sync (per INV-SCHEMA-ENUM-004):
 *   1. Prisma schema  — `enum FailedKnownReason` (SSOT)
 *   2. TypeScript     — `packages/core/src/types/failed-known-reason.ts`
 *   3. Zod schema     — this file (consumed by IPC schema + MCP tool I/O)
 *   4. OpenAPI/MCP    — `apps/mcp-server/src/tools/page/get-job-status.tool.ts`
 *
 * 4-layer sync (per INV-SCHEMA-ENUM-004): Prisma → TS → Zod → MCP tool spec.
 *
 * @see PR-V3-T4 design.md §6.2 (4-layer sync table)
 * @see INV-SCHEMA-ENUM-004 standing regression (schema-enum-sync domain)
 *
 * @module schemas/failed-known-reason.schema
 */

import { z } from "zod";

import { FAILED_KNOWN_REASONS, type FailedKnownReason } from "@reftrixmcp/core";

// ============================================================================
// Schema
// ============================================================================

/**
 * Zod enum mirror of {@link FailedKnownReason} (6 values, exhaustive).
 *
 * Zod enum mirror (6 値、exhaustive)。
 */
export const FailedKnownReasonSchema = z.enum(
  FAILED_KNOWN_REASONS as readonly [FailedKnownReason, ...FailedKnownReason[]]
);

/** Inferred type — equals {@link FailedKnownReason} (4-layer sync). */
export type FailedKnownReasonZ = z.infer<typeof FailedKnownReasonSchema>;
