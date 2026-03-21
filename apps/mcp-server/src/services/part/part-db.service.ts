// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Part DB Service
 *
 * 抽出されたパーツをデータベースに保存するサービス。
 * Prisma createMany でバッチ挿入し、
 * @@unique([sectionPatternId, visualSignature]) 制約で重複をスキップ。
 *
 * Service for saving extracted parts to the database.
 * Uses Prisma createMany for batch insert,
 * with @@unique([sectionPatternId, visualSignature]) constraint to skip duplicates.
 *
 * @module services/part/part-db.service
 */

import type { PrismaClient, Prisma } from "@prisma/client";
import type { ExtractedPart } from "./types";
import { logger } from "../../utils/logger";
import { truncateId } from "./schemas";

// ============================================================================
// Types / 型定義
// ============================================================================

/**
 * 保存結果 / Save result
 */
export interface PartSaveResult {
  /** 保存されたパーツ数 / Number of saved parts */
  savedCount: number;
  /** 重複スキップされたパーツ数 / Number of skipped duplicates */
  skippedDuplicates: number;
}

// ============================================================================
// Public Functions / 公開関数
// ============================================================================

/**
 * 抽出されたパーツをデータベースに一括保存する
 * Save extracted parts to database in batch
 *
 * - createMany + skipDuplicates で @@unique 制約の重複をスキップ
 * - ロゴパーツは htmlSnippet=null、画像なしで保存
 * - cropBuffer はDB保存対象外（Embedding生成後に破棄）
 *
 * @param prisma - Prismaクライアント / Prisma client
 * @param webPageId - WebページID / Web page ID
 * @param sectionPatternId - セクションパターンID / Section pattern ID
 * @param parts - 抽出済みパーツ一覧 / List of extracted parts
 * @param sourceUrl - ソースURL / Source URL
 * @returns 保存結果 / Save result
 */
export async function saveExtractedParts(
  prisma: PrismaClient,
  webPageId: string,
  sectionPatternId: string,
  parts: ExtractedPart[],
  sourceUrl: string | null
): Promise<PartSaveResult> {
  if (parts.length === 0) {
    return { savedCount: 0, skippedDuplicates: 0 };
  }

  // Prisma の InputJsonObject はインデックスシグネチャを要求するため、
  // 型付きオブジェクトを Prisma.InputJsonValue にキャストする。
  // Prisma InputJsonObject requires index signature,
  // so cast typed objects to Prisma.InputJsonValue.
  const data = parts.map((part) => ({
    webPageId,
    sectionPatternId,
    partType: part.partType,
    partSubtype: part.partSubtype,
    htmlSnippet: part.htmlSnippet,
    computedStyles: part.computedStyles as Prisma.InputJsonValue,
    boundingBox: part.boundingBox as unknown as Prisma.InputJsonValue,
    cssClasses: part.cssClasses,
    attributes: part.attributes as Prisma.InputJsonValue,
    interactionInfo: part.interactionInfo as unknown as Prisma.InputJsonValue,
    visualSignature: part.visualSignature,
    sampleIndex: part.sampleIndex,
    piiRiskLevel: part.piiRiskLevel,
    tags: part.tags,
    metadata: part.metadata as Prisma.InputJsonValue,
    sourceUrl: sourceUrl ?? part.sourceUrl,
    usageScope: part.usageScope,
    extractedAt: new Date(),
  }));

  try {
    const result = await prisma.componentPart.createMany({
      data,
      skipDuplicates: true,
    });

    const skippedDuplicates = parts.length - result.count;

    logger.info("[part-db] Parts saved to database", {
      webPageId: truncateId(webPageId),
      sectionPatternId: truncateId(sectionPatternId),
      totalParts: parts.length,
      savedCount: result.count,
      skippedDuplicates,
    });

    return {
      savedCount: result.count,
      skippedDuplicates,
    };
  } catch (error) {
    logger.error("[part-db] Failed to save parts", {
      webPageId: truncateId(webPageId),
      sectionPatternId: truncateId(sectionPatternId),
      partCount: parts.length,
      error: (error as Error).message,
    });
    throw error;
  }
}
