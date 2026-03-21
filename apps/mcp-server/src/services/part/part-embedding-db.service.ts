// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Part Embedding DB Service
 *
 * パーツEmbeddingのデータベース保存サービス。
 * Prisma createMany（非ベクトルフィールド）+ raw SQL（vectorカラム更新）の
 * 2段階アプローチでComponentPartEmbeddingテーブルにレコードを保存する。
 *
 * Database persistence service for part embeddings.
 * Uses a 2-step approach: Prisma createMany (non-vector fields) + raw SQL
 * (vector column update) to save records to ComponentPartEmbedding table.
 *
 * パターン:
 * - Step 1: Prisma createMany で基本レコード挿入（vectorカラムを除く）
 * - Step 2: $executeRawUnsafe で visual_embedding, text_embedding を更新
 * - background-design-embedding.service.ts と同一の DI パターン
 *
 * Patterns:
 * - Step 1: Prisma createMany for base records (excluding vector columns)
 * - Step 2: $executeRawUnsafe for visual_embedding, text_embedding update
 * - Same DI pattern as background-design-embedding.service.ts
 *
 * @module services/part/part-embedding-db
 */

import { logger } from "../../utils/logger";
import { truncateId } from "./schemas";
import type { PartEmbeddingResult } from "./part-embedding.service";

// ============================================================================
// Types / 型定義
// ============================================================================

/**
 * DB保存結果
 * DB save result
 */
export interface PartEmbeddingSaveResult {
  /** 保存成功件数 / Number of successfully saved records */
  savedCount: number;
  /** エラー一覧 / List of errors */
  errors: string[];
}

/**
 * PrismaClient互換インターフェース（DI用）
 * PrismaClient compatible interface (for DI)
 *
 * テストでモック可能にするため最小限のインターフェースとして定義。
 * Defined as minimal interface to allow mocking in tests.
 */
export interface PartEmbeddingPrismaClient {
  componentPartEmbedding: {
    create: (args: {
      data: {
        componentPartId: string;
        textRepresentation: string | null;
        visualModelVersion: string;
        textModelVersion: string;
        embeddingTimestamp: Date;
      };
    }) => Promise<{ id: string }>;
  };
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
}

// ============================================================================
// Constants / 定数
// ============================================================================

/** DINOv2モデルバージョン / DINOv2 model version */
const VISUAL_MODEL_VERSION = "dinov2-vit-b14";

/** e5-baseモデルバージョン / e5-base model version */
const TEXT_MODEL_VERSION = "multilingual-e5-base";

// ============================================================================
// Public Functions / 公開関数
// ============================================================================

/**
 * パーツEmbeddingをデータベースに保存する
 * Save part embeddings to database
 *
 * 2段階アプローチ:
 * Step 1: Prisma create で基本レコード挿入（vectorカラムを除く）
 * Step 2: $executeRawUnsafe で visual_embedding, text_embedding を更新
 *
 * 2-step approach:
 * Step 1: Prisma create for base record (excluding vector columns)
 * Step 2: $executeRawUnsafe for visual_embedding, text_embedding update
 *
 * @param prisma - PrismaClientインスタンス / PrismaClient instance
 * @param embeddings - Embedding生成結果一覧 / Embedding generation results
 * @returns 保存結果 / Save result
 */
export async function savePartEmbeddings(
  prisma: PartEmbeddingPrismaClient,
  embeddings: PartEmbeddingResult[]
): Promise<PartEmbeddingSaveResult> {
  const result: PartEmbeddingSaveResult = {
    savedCount: 0,
    errors: [],
  };

  if (embeddings.length === 0) {
    return result;
  }

  logger.info("[part-embedding-db] Starting embedding save", {
    totalEmbeddings: embeddings.length,
  });

  const startTime = Date.now();

  // 逐次処理（各レコードを個別に保存）
  // Sequential processing (save each record individually)
  for (const embedding of embeddings) {
    try {
      // Step 1: 基本レコード挿入（vectorカラムを除く）
      // Step 1: Insert base record (excluding vector columns)
      const createdRecord = await prisma.componentPartEmbedding.create({
        data: {
          componentPartId: embedding.componentPartId,
          textRepresentation: embedding.textRepresentation,
          visualModelVersion: VISUAL_MODEL_VERSION,
          textModelVersion: TEXT_MODEL_VERSION,
          embeddingTimestamp: new Date(),
        },
      });

      // Step 2: raw SQL で vector カラムを更新
      // Step 2: Update vector columns via raw SQL
      if (embedding.visualEmbedding !== null) {
        const visualVectorString = `[${embedding.visualEmbedding.join(",")}]`;
        const textVectorString = `[${embedding.textEmbedding.join(",")}]`;
        await prisma.$executeRawUnsafe(
          `UPDATE component_part_embeddings
           SET visual_embedding = $1::vector(768),
               text_embedding = $2::vector(768)
           WHERE id = $3::uuid`,
          visualVectorString,
          textVectorString,
          createdRecord.id
        );
      } else {
        // ビジュアルEmbeddingがない場合はテキストEmbeddingのみ更新
        // Update text embedding only when visual embedding is absent
        const textVectorString = `[${embedding.textEmbedding.join(",")}]`;
        await prisma.$executeRawUnsafe(
          `UPDATE component_part_embeddings
           SET text_embedding = $1::vector(768)
           WHERE id = $2::uuid`,
          textVectorString,
          createdRecord.id
        );
      }

      result.savedCount++;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      result.errors.push(
        `Failed to save embedding for part ${truncateId(embedding.componentPartId)}: ${errorMessage}`
      );

      logger.warn("[part-embedding-db] Failed to save embedding", {
        componentPartId: truncateId(embedding.componentPartId),
        error: errorMessage,
      });
    }
  }

  const durationMs = Date.now() - startTime;
  logger.info("[part-embedding-db] Embedding save complete", {
    totalEmbeddings: embeddings.length,
    savedCount: result.savedCount,
    failedCount: result.errors.length,
    durationMs,
  });

  return result;
}
