// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * section.inspect の Zod 入力スキーマ（WebUI v1 W6 Issue A PR-1）
 *
 * API 境界バリデーション（T1 Canonical）: section_id は UUID 必須（id resolution の入口）、
 * include_* は additive opt-out（default false）。JSON Schema（inspect.tool.ts の
 * sectionInspectToolDefinition.inputSchema）と整合させること。
 *
 * 注: `z.string().uuid()` は version-agnostic（UUID v4 も accept する）ため、本スキーマは
 * 「UUID」と表記する（「UUIDv7」表記は validator を過大表現するため使わない）。section.inspect は
 * single-tenant（tenant/owner 列を持たない）ゆえ、存在しない section_pattern_id の reject は
 * authz/IDOR control ではなく id resolution の null-row 非開示（NOT_FOUND）である（part.inspect の
 * precedent と同一）。
 *
 * Zod input schema for section.inspect (T1 Canonical API-boundary validation). Keep in sync with
 * the JSON Schema in `inspect.tool.ts` (`sectionInspectToolDefinition.inputSchema`).
 *
 * Note: `z.string().uuid()` is version-agnostic (it also accepts UUID v4), so this schema is
 * documented as "UUID" (the term "UUIDv7" would over-state the validator). section.inspect is
 * single-tenant (no tenant/owner column), so rejecting a non-existent section_pattern_id is NOT an
 * authz/IDOR control — it is null-row non-disclosure (NOT_FOUND) of id resolution (same as the
 * part.inspect precedent).
 *
 * @module tools/section/schemas
 */

import { z } from "zod";

/**
 * section.inspect 入力スキーマ
 * section.inspect input schema
 *
 * - `section_id`: セクションパターンID（UUID）。不正 UUID は VALIDATION_ERROR。
 * - `include_structure_preview`: サニタイズ済み構造プレビューを含める（opt-in、default false）。
 * - `include_parts_summary`: セクション内パーツサマリを含める（opt-in、default false）。
 */
export const sectionInspectInputSchema = z.object({
  section_id: z.string().uuid(),
  include_structure_preview: z.boolean().default(false),
  include_parts_summary: z.boolean().default(false),
});

/** section.inspect 入力型（Zod から推論） / section.inspect input type (inferred from Zod) */
export type SectionInspectInput = z.infer<typeof sectionInspectInputSchema>;
