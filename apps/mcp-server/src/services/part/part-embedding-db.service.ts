// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Part Embedding DB Service
 *
 * パーツEmbeddingのデータベース保存サービス。
 * `prisma.$transaction` で `createMany` (非ベクトル column) + `$executeRawUnsafe`
 * (vector(768) column UPDATE) を atomic に実行する 2-step transaction write。
 *
 * Database persistence service for part embeddings.
 * Executes `createMany` (non-vector columns) + `$executeRawUnsafe` (vector(768)
 * column UPDATE) atomically inside a single `prisma.$transaction`.
 *
 * パターン:
 * - Step 0 (transaction 前段): NaN/Infinity pre-filter (ADR-0018 §Decision 3.6,
 *   UC-04, SEC-02 CWE-20)
 * - Step 1 (transaction 内): Prisma createMany で基本レコード挿入（vectorカラムを除く）
 * - Step 2 (transaction 内): $executeRawUnsafe で visual_embedding / text_embedding を更新
 * - Atomic rollback: 任意 step の例外 → transaction rollback → 半書込なし
 *
 * Pattern:
 * - Step 0 (pre-transaction): NaN/Infinity pre-filter (ADR-0018 §Decision 3.6)
 * - Step 1 (inside tx): Prisma createMany for base records (excluding vector columns)
 * - Step 2 (inside tx): $executeRawUnsafe for visual_embedding / text_embedding UPDATE
 * - Atomic rollback: any step exception → transaction rollback → no half-written rows
 *
 * @see ADR-0018 §Decision 3 (atomic dual-phase write) and §Decision 3 Amendment
 * @see INV-EMBEDDING-INTEGRITY-002-A (PR-D-2)
 * @see PR-D-2 Plan §2.1
 *
 * @module services/part/part-embedding-db
 */

import { logger } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { truncateId } from "./schemas";
import type { PartEmbeddingResult } from "./part-embedding.service";

// ============================================================================
// Types / 型定義
// ============================================================================

/**
 * DB保存結果
 * DB save result
 *
 * PR-D-3 (UC-06, 2026-04-27 deadline): 旧 `savedCount` deprecated alias を完全
 * 削除し `generatedCount` を唯一の SSOT とした。INV-EMBEDDING-INTEGRITY-002 に
 * 従い `createMany.count` のみから導出される。
 *
 * PR-D-3 (UC-06, 2026-04-27 deadline): The legacy `savedCount` deprecated alias
 * has been fully removed; `generatedCount` is now the sole SSOT, derived solely
 * from `createMany.count` per INV-EMBEDDING-INTEGRITY-002.
 */
export interface PartEmbeddingSaveResult {
  /**
   * 保存成功件数 (INV-EMBEDDING-INTEGRITY-002 に従い createMany.count から導出)。
   * 唯一の SSOT。PR-D-2 で導入されていた `savedCount` alias は PR-D-3 で削除
   * (UC-06, 2026-04-27 deadline)。
   *
   * Number of successfully saved records (derived from createMany.count per
   * INV-EMBEDDING-INTEGRITY-002). Sole SSOT; the prior `savedCount` alias
   * introduced in PR-D-2 was removed in PR-D-3 (UC-06, 2026-04-27 deadline).
   */
  generatedCount: number;
  /**
   * NaN/Infinity pre-filter で除外された embedding 件数 (UC-04 / SEC-02)。
   * transaction 境界の前段で `Number.isFinite()` 検証によって弾かれた件数。
   * Count of embeddings filtered by the NaN/Infinity pre-filter before the
   * transaction boundary (UC-04 / SEC-02).
   */
  filteredNonFinite: number;
  /**
   * エラー一覧 (client-safe)。PR-D-3 (FIND-IMPL-SEC-01, 2026-05-04 deadline):
   * transaction rollback 時は `sanitizeErrorMessage()` 経由で CWE-209 Information
   * Exposure を防止した generic message のみを含む。raw Prisma message / SQL
   * keyword / internal column 名は含まない。Server-side diagnostic は
   * `logger.warn` の第 2 引数 (raw `message` + `code`) を参照すること。
   *
   * List of errors (client-safe). Per PR-D-3 (FIND-IMPL-SEC-01, 2026-05-04
   * deadline): transaction rollback entries contain only generic messages from
   * `sanitizeErrorMessage()` that defend against CWE-209 Information Exposure.
   * Raw Prisma messages, SQL keywords, and internal column names are never
   * surfaced here. For server-side diagnostics, consult `logger.warn`'s 2nd
   * argument (raw `message` + `code`).
   */
  errors: string[];
}

/**
 * PrismaClient互換インターフェース（DI用）
 * PrismaClient compatible interface (for DI)
 *
 * PR-D-2: `$transaction` interactive transaction をサポート。`tx` callback は
 * `createMany` + `$executeRawUnsafe` を同一 connection で実行するため、payload
 * type は PrismaClient 全体ではなく transaction-scoped subset のみを要求する。
 *
 * PR-D-2: Supports interactive `$transaction`. Because the `tx` callback
 * executes `createMany` + `$executeRawUnsafe` on the same connection, the
 * payload type requires only the transaction-scoped subset (not the full
 * PrismaClient).
 */
export interface PartEmbeddingPrismaClient {
  componentPartEmbedding: {
    createMany: (args: {
      data: Array<{
        componentPartId: string;
        textRepresentation: string | null;
        visualModelVersion: string;
        textModelVersion: string;
        embeddingTimestamp: Date;
      }>;
      skipDuplicates?: boolean;
    }) => Promise<{ count: number }>;
  };
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
  /**
   * Prisma interactive transaction. Callback 内の `tx` は同一 connection を
   * 保持するため `createMany` + `$executeRawUnsafe` の atomic 実行を保証。
   * Prisma 6 の仕様: `$transaction(fn, { timeout })` は callback scope 内の
   * `tx` に対する全操作を同じ DB connection にバインドする (UC-03 で実証)。
   *
   * Prisma interactive transaction. The `tx` passed to the callback uses the
   * same connection, guaranteeing atomic execution of `createMany` +
   * `$executeRawUnsafe`. Per Prisma 6 spec: `$transaction(fn, { timeout })`
   * binds all operations on `tx` to the same DB connection (proven by UC-03).
   */
  $transaction: <T>(
    fn: (tx: PartEmbeddingPrismaClient) => Promise<T>,
    options?: { timeout?: number }
  ) => Promise<T>;
}

// ============================================================================
// Constants / 定数
// ============================================================================

/** DINOv2モデルバージョン / DINOv2 model version */
const VISUAL_MODEL_VERSION = "dinov2-vit-b14";

/** e5-baseモデルバージョン / e5-base model version */
const TEXT_MODEL_VERSION = "multilingual-e5-base";

/**
 * `$transaction` timeout (ms)。ADR-0018 §Decision 3.5 / FIND-PLAN-09。
 * default 5s では 100 part chunk の UPDATE loop + pgvector index write p95
 * spike で margin 不足のため 10s に設定。
 *
 * `$transaction` timeout in ms. Per ADR-0018 §Decision 3.5 / FIND-PLAN-09:
 * the default 5s provides insufficient margin for a 100-part chunk's UPDATE
 * loop plus pgvector index write p95 spikes, so 10s is explicitly chosen.
 */
const TRANSACTION_TIMEOUT_MS = 10_000;

// ============================================================================
// Internal Helpers / 内部ヘルパー
// ============================================================================

/**
 * Embedding が NaN / Infinity を含むか検証する。
 * `visualEmbedding === null` の text-only ケースも考慮し、null は valid 扱い。
 *
 * Validates that an embedding contains no NaN / Infinity. For text-only cases
 * (`visualEmbedding === null`), null is treated as valid.
 *
 * @param embedding - 検証対象 / Embedding to validate
 * @returns `true` if all finite values (or null for visual); `false` otherwise
 */
function isEmbeddingFinite(embedding: PartEmbeddingResult): boolean {
  // Text embedding must always exist and be all-finite.
  if (!embedding.textEmbedding.every((v) => Number.isFinite(v))) {
    return false;
  }
  // Visual embedding is nullable (text-only case). If present, must be all-finite.
  if (embedding.visualEmbedding !== null) {
    if (!embedding.visualEmbedding.every((v) => Number.isFinite(v))) {
      return false;
    }
  }
  return true;
}

// ============================================================================
// Public Functions / 公開関数
// ============================================================================

/**
 * パーツEmbeddingをデータベースに保存する (atomic dual-phase write)。
 * Save part embeddings to database (atomic dual-phase write).
 *
 * 2-step atomic transaction:
 * Step 0 (pre-transaction): NaN/Infinity pre-filter
 * Step 1 (inside tx): Prisma createMany で基本レコード挿入（vectorカラムを除く）
 * Step 2 (inside tx): $executeRawUnsafe で visual_embedding / text_embedding を更新
 *
 * 2-step atomic transaction:
 * Step 0 (pre-transaction): NaN/Infinity pre-filter
 * Step 1 (inside tx): Prisma createMany for base records (excluding vector columns)
 * Step 2 (inside tx): $executeRawUnsafe for visual_embedding / text_embedding UPDATE
 *
 * 契約 / Contract (ADR-0018 §Decision 3 Amendment / INV-EMBEDDING-INTEGRITY-002-A):
 * - transaction 全体が atomic: 任意 step 失敗 → rollback → 半書込なし
 * - `generatedCount` は `createMany.count` から導出 (loop counter 禁止、INV-002)
 * - timeout 10s 明示 (FIND-PLAN-09)
 * - NaN/Infinity pre-filter は transaction 境界の前段で実行 (UC-04)
 *
 * Contract:
 * - The entire transaction is atomic: any step failure → rollback → no
 *   half-written rows
 * - `generatedCount` derived from `createMany.count` (loop counter prohibited
 *   per INV-002)
 * - Explicit 10s timeout (FIND-PLAN-09)
 * - NaN/Infinity pre-filter runs pre-transaction (UC-04)
 *
 * @param prisma - PrismaClient互換インスタンス / PrismaClient-compatible instance
 * @param embeddings - Embedding生成結果一覧 / Embedding generation results
 * @returns 保存結果 / Save result
 */
export async function savePartEmbeddings(
  prisma: PartEmbeddingPrismaClient,
  embeddings: PartEmbeddingResult[]
): Promise<PartEmbeddingSaveResult> {
  const result: PartEmbeddingSaveResult = {
    generatedCount: 0,
    filteredNonFinite: 0,
    errors: [],
  };

  if (embeddings.length === 0) {
    return result;
  }

  // --------------------------------------------------------------------------
  // Step 0 (pre-transaction): NaN/Infinity pre-filter
  //   ADR-0018 §Decision 3.6 / UC-04 / SEC-02 (CWE-20 Improper Input Validation)
  //   `.claude/rules/security.md` §Vector Data Validation
  // --------------------------------------------------------------------------
  const finiteEmbeddings: PartEmbeddingResult[] = [];
  for (const emb of embeddings) {
    if (isEmbeddingFinite(emb)) {
      finiteEmbeddings.push(emb);
    } else {
      result.filteredNonFinite++;
      // PII-free log: componentPartId を truncateId で切り詰め、値自体は含めない
      // PII-free log: truncate componentPartId; do not log embedding values
      logger.warn("[part-embedding-db] Embedding contains NaN/Infinity, pre-filtered", {
        componentPartId: truncateId(emb.componentPartId),
      });
    }
  }

  if (finiteEmbeddings.length === 0) {
    // All embeddings filtered — no transaction needed, return early.
    logger.info("[part-embedding-db] All embeddings filtered by NaN/Infinity pre-filter", {
      totalEmbeddings: embeddings.length,
      filteredNonFinite: result.filteredNonFinite,
    });
    return result;
  }

  logger.info("[part-embedding-db] Starting atomic embedding save", {
    totalEmbeddings: embeddings.length,
    validEmbeddings: finiteEmbeddings.length,
    filteredNonFinite: result.filteredNonFinite,
  });

  const startTime = Date.now();
  const embeddingTimestamp = new Date();

  // --------------------------------------------------------------------------
  // Step 1 + Step 2: atomic transaction
  //   ADR-0018 §Decision 3 Amendment (2-step interactive transaction)
  //   timeout 10s (FIND-PLAN-09 / §Decision 3.5)
  //
  // Transaction rollback behavior:
  //   - 任意 step の例外 → transaction 全体が rollback
  //   - Step 1 の createMany 成功 + Step 2 の UPDATE 失敗でも、
  //     commit されていない Step 1 の row は rollback で撤回される
  //     (半書込 row は DB に残らない、INV-EMBEDDING-INTEGRITY-002-A 遵守)
  //   - Timeout 10s 超過時も自動 rollback
  //
  // Any step raising → the entire transaction rolls back. Even if Step 1
  // createMany succeeds but Step 2 UPDATE fails, the uncommitted Step 1 rows
  // are withdrawn on rollback, leaving NO half-written rows
  // (INV-EMBEDDING-INTEGRITY-002-A compliance). Timeout 10s also triggers
  // automatic rollback.
  // --------------------------------------------------------------------------
  try {
    const txResult = await prisma.$transaction(
      async (tx: PartEmbeddingPrismaClient) => {
        // Step 1: 非ベクトル column を bulk insert (createMany)
        //   - visual_embedding / text_embedding は含めない
        //     (schema.prisma L1787-1788 の Unsupported("vector(768)") により
        //     Prisma 6 createMany で書込不可)
        // Step 1: bulk insert non-vector columns via createMany.
        //   Excludes visual_embedding / text_embedding because Prisma 6's
        //   `Unsupported("vector(768)")` prohibits them in createMany payloads
        //   (schema.prisma L1787-1788).
        const created = await tx.componentPartEmbedding.createMany({
          data: finiteEmbeddings.map((e) => ({
            componentPartId: e.componentPartId,
            textRepresentation: e.textRepresentation,
            visualModelVersion: VISUAL_MODEL_VERSION,
            textModelVersion: TEXT_MODEL_VERSION,
            embeddingTimestamp,
          })),
          skipDuplicates: false,
        });

        // Step 2: vector(768) column を parameterized raw UPDATE
        //   - component_part_id は UNIQUE なので row 特定に使用可能
        //   - positional params で SQL injection を回避 (SEC)
        // Step 2: parameterized raw UPDATE for vector(768) columns.
        //   component_part_id is UNIQUE, so it can target rows uniquely.
        //   Positional params prevent SQL injection (SEC).
        for (const emb of finiteEmbeddings) {
          const textVectorString = `[${emb.textEmbedding.join(",")}]`;
          if (emb.visualEmbedding !== null) {
            const visualVectorString = `[${emb.visualEmbedding.join(",")}]`;
            await tx.$executeRawUnsafe(
              `UPDATE component_part_embeddings
                 SET visual_embedding = $1::vector(768),
                     text_embedding   = $2::vector(768)
               WHERE component_part_id = $3::uuid`,
              visualVectorString,
              textVectorString,
              emb.componentPartId
            );
          } else {
            // Visual Embedding がない場合は text のみ更新。
            // Text-only case: update text_embedding only.
            await tx.$executeRawUnsafe(
              `UPDATE component_part_embeddings
                 SET text_embedding = $1::vector(768)
               WHERE component_part_id = $2::uuid`,
              textVectorString,
              emb.componentPartId
            );
          }
        }

        return { count: created.count };
      },
      { timeout: TRANSACTION_TIMEOUT_MS }
    );

    // generatedCount is derived from createMany.count (INV-EMBEDDING-INTEGRITY-002).
    // SSOT consolidated in PR-D-3: `savedCount` alias removed (UC-06).
    result.generatedCount = txResult.count;
  } catch (error) {
    // --------------------------------------------------------------------------
    // Transaction rollback — atomicity preserved, no half-written rows.
    // PR-D-3 (FIND-IMPL-SEC-01, 2026-05-04 deadline / ADR-0018 §3.9):
    //   - Client-facing `result.errors[]`: sanitized message only (CWE-209 defense).
    //   - Server-side `logger.warn` (2nd arg): raw message + error code preserved
    //     for debugging (PII-safe because it does not carry user input, and
    //     PartIDs are truncated to the first 8 chars via `truncateId`).
    //
    // PR-D-3 (FIND-IMPL-SEC-01): client 向けは sanitize 済 message のみ、
    // server-side log には raw message + code を保全して debug 性能を維持する。
    // --------------------------------------------------------------------------
    const rawErrorCode = (error as { code?: string }).code;
    const rawErrorMessage = error instanceof Error ? error.message : String(error);
    const truncatedIds = finiteEmbeddings
      .slice(0, 5)
      .map((e) => truncateId(e.componentPartId))
      .join(",");

    // Client-safe: `sanitizeErrorMessage` maps Prisma error codes (P2002 /
    // P2025 / P2003 / ...) and generic error categories to a fixed whitelist
    // of user-facing strings, stripping SQL snippets and internal schema names.
    const safeMessage = sanitizeErrorMessage(error);
    result.errors.push(
      `Transaction rolled back (${finiteEmbeddings.length} embeddings): ${safeMessage}`
    );

    logger.warn("[part-embedding-db] Transaction rolled back (atomic failure)", {
      totalToWrite: finiteEmbeddings.length,
      firstPartIds: truncatedIds,
      code: rawErrorCode,
      rawMessage: rawErrorMessage,
    });
    // Note: generatedCount remains 0 (rollback → nothing written).
  }

  const durationMs = Date.now() - startTime;
  logger.info("[part-embedding-db] Atomic embedding save complete", {
    totalEmbeddings: embeddings.length,
    validEmbeddings: finiteEmbeddings.length,
    filteredNonFinite: result.filteredNonFinite,
    generatedCount: result.generatedCount,
    failedCount: result.errors.length,
    durationMs,
  });

  return result;
}
