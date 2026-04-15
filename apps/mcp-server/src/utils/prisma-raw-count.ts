// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Prisma Raw Count Utility — Safe Non-null Vector Counting
 *
 * v0.4.0 PR6 TDA TD-1: `page-analyze-worker.ts` に重複していた
 * `queryCountNonNull()` ローカルヘルパーを util に抽出する。
 *
 * v0.4.0 PR6 TDA TD-1: Extracts the duplicated `queryCountNonNull()` local helper
 * from `page-analyze-worker.ts` into a shared util.
 *
 * 背景 / Background:
 * Prisma の `Unsupported("vector(768)")` カラムは where 句で `{ not: null }`
 * を受け付けないため、非 NULL 件数を取得するには raw SQL が必須。無条件に
 * `$queryRawUnsafe` を使うと SQL injection のリスクが増えるため、本 util は
 * table / column 名を allowlist で検証し、webPageId のみをパラメータ化する。
 *
 * Prisma's `Unsupported("vector(768)")` columns cannot be filtered with
 * `{ not: null }` in `where`, so raw SQL is required for non-null counts.
 * Unrestricted `$queryRawUnsafe` invites SQL injection risk, so this util
 * validates table / column names against an allowlist and parameterizes only
 * the webPageId argument.
 *
 * @module utils/prisma-raw-count
 */

import type { PrismaClient } from "@prisma/client";

/**
 * Allowlisted embedding tables. Each entry must be an existing relation in
 * the Reftrix Prisma schema and is referenced by {@link countNonNullVector}.
 *
 * 許可された embedding テーブル一覧。Reftrix の Prisma schema に存在する
 * リレーションのみを列挙し、{@link countNonNullVector} から参照される。
 */
export const ALLOWED_EMBEDDING_TABLES = [
  "section_embeddings",
  "component_part_embeddings",
] as const;

/**
 * Allowlisted non-null-checkable vector columns. Combined with the table
 * allowlist, this yields a finite SQL surface that cannot be injected.
 *
 * 非 NULL チェック可能な vector カラム許可リスト。テーブル許可リストと合わせて
 * SQL injection 可能面を完全に閉じる。
 */
export const ALLOWED_VECTOR_COLUMNS = [
  "text_embedding",
  "vision_embedding",
  "visual_embedding",
] as const;

export type AllowedEmbeddingTable = (typeof ALLOWED_EMBEDDING_TABLES)[number];
export type AllowedVectorColumn = (typeof ALLOWED_VECTOR_COLUMNS)[number];

/**
 * Options for {@link countNonNullVector}.
 */
export interface CountNonNullVectorOptions {
  /** Prisma client (DI を許容) / Prisma client (DI-friendly) */
  prisma: PrismaClient;
  /** Target table (allowlisted) / 対象テーブル（allowlist 検証） */
  table: AllowedEmbeddingTable;
  /** Target column (allowlisted) / 対象カラム（allowlist 検証） */
  column: AllowedVectorColumn;
  /**
   * Optional JOIN clause. Must use parameter placeholder `$1::uuid` for
   * webPageId. Caller supplies the JOIN SQL fragment and is responsible for
   * its safety — the fragment itself is a static template, not user input.
   *
   * 任意の JOIN 句。`$1::uuid` プレースホルダを使用すること。呼び出し側が
   * 静的テンプレートとして供給し、ユーザー入力は含めない。
   */
  joinFragment: string;
  /** WHERE 句末尾の web_page_id フィルタ列（例 sp.web_page_id） / web_page_id filter column */
  webPageIdColumn: string;
  /** WebPage UUID (parameterized) / パラメータ化される webPageId */
  webPageId: string;
}

/**
 * Count rows where a non-nullable vector column is NOT NULL for a given
 * webPageId. Uses a parameterized raw SQL query that can't be filtered via
 * the Prisma client's high-level API due to the `Unsupported("vector(768)")`
 * column type.
 *
 * 指定 webPageId について、非 NULL の vector カラム行数を返す。Prisma の
 * `Unsupported("vector(768)")` 型制約により `$queryRawUnsafe` を用いるが、
 * table / column は allowlist で閉じ込め、webPageId はパラメータ化する。
 *
 * @returns 行数（NaN/負値はクランプして 0） / Row count (NaN/negative clamped to 0)
 */
export async function countNonNullVector(options: CountNonNullVectorOptions): Promise<number> {
  const { prisma, table, column, joinFragment, webPageIdColumn, webPageId } = options;

  // Defensive allowlist validation (defense in depth beyond TypeScript literal types)
  // 防御的 allowlist 検証（TypeScript リテラル型に加えた defense in depth）
  if (!ALLOWED_EMBEDDING_TABLES.includes(table)) {
    throw new Error(`[countNonNullVector] Invalid table: ${table}`);
  }
  if (!ALLOWED_VECTOR_COLUMNS.includes(column)) {
    throw new Error(`[countNonNullVector] Invalid column: ${column}`);
  }
  // webPageIdColumn は allowlist 化しないが、識別子として英数字・アンダースコア・
  // ドットのみを許容する（JOIN 別名の指定に使われるため）。
  // webPageIdColumn is not allowlisted but restricted to alphanumeric / underscore /
  // dot (used to reference JOIN aliases).
  if (!/^[a-zA-Z_][a-zA-Z0-9_.]{0,63}$/.test(webPageIdColumn)) {
    throw new Error(`[countNonNullVector] Invalid webPageIdColumn: ${webPageIdColumn}`);
  }

  // table / column / webPageIdColumn はすべて allowlist 検証済み
  // table / column / webPageIdColumn are all allowlist-validated
  const sql = `SELECT COUNT(*)::bigint AS count FROM "${table}" t
    ${joinFragment}
    WHERE ${webPageIdColumn} = $1::uuid AND t."${column}" IS NOT NULL`;

  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint | string }>>(sql, webPageId);
  const raw = rows[0]?.count ?? 0;
  const n = typeof raw === "bigint" ? Number(raw) : Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
