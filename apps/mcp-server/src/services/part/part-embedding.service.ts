// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Part Embedding Service
 *
 * コンポーネントパーツのEmbedding生成サービス。
 * DINOv2によるビジュアルEmbeddingとe5-baseによるテキストEmbeddingを生成する。
 *
 * Embedding generation service for component parts.
 * Generates DINOv2 visual embeddings and e5-base text embeddings.
 *
 * パターン:
 * - DINOv2: 224x224 RGB cropBuffer → 768D L2正規化ベクトル
 * - e5-base: "passage: {text}" → 768D ベクトル
 * - OOM防止のため逐次処理（Promise.allではなくforループ）
 * - NaN/Infinity/ゼロベクトル検証 [H-3]
 *
 * Patterns:
 * - DINOv2: 224x224 RGB cropBuffer → 768D L2-normalized vector
 * - e5-base: "passage: {text}" → 768D vector
 * - Sequential processing for OOM prevention (for-loop, not Promise.all)
 * - NaN/Infinity/zero vector validation [H-3]
 *
 * @module services/part/part-embedding
 */

import type { DINOv2Service } from "@reftrixmcp/ml";
import { DINOV2_EMBEDDING_DIMENSION } from "@reftrixmcp/ml";
import { logger } from "../../utils/logger";
import { truncateId } from "./schemas";

// ============================================================================
// Types / 型定義
// ============================================================================

/**
 * Embedding生成用のパーツデータ（最小限のフィールド）
 * Part data for embedding generation (minimal fields)
 */
export interface ComponentPartForEmbedding {
  /** パーツID / Part ID */
  id: string;
  /** パーツタイプ / Part type */
  partType: string;
  /** パーツサブタイプ / Part subtype */
  partSubtype: string | null;
  /** 計算済みスタイル / Computed styles */
  computedStyles: Record<string, string>;
  /** CSSクラスリスト / CSS class list */
  cssClasses: string[];
  /** HTML属性（PIIマスク済み） / HTML attributes (PII-masked) */
  attributes: Record<string, string>;
  /** インタラクション情報 / Interaction information */
  interactionInfo: Record<string, boolean>;
}

/**
 * cropBuffer付きパーツデータ
 * Part data with crop buffer
 */
export interface ComponentPartWithCrop extends ComponentPartForEmbedding {
  /** クロップ済み画像バッファ（piiRiskLevel='high'やロゴの場合はnull） / Cropped image buffer (null for high PII risk or logos) */
  cropBuffer: Buffer | null;
}

/**
 * Embedding生成結果
 * Embedding generation result
 */
export interface PartEmbeddingResult {
  /** コンポーネントパーツID / Component part ID */
  componentPartId: string;
  /** ビジュアルEmbedding（cropBufferがない場合はnull） / Visual embedding (null if no cropBuffer) */
  visualEmbedding: number[] | null;
  /** テキストEmbedding / Text embedding */
  textEmbedding: number[];
  /** テキスト表現 / Text representation */
  textRepresentation: string;
}

/**
 * EmbeddingService互換インターフェース（DI用）
 * EmbeddingService compatible interface (for DI)
 *
 * e5-baseのEmbeddingServiceが提供するgenerateEmbedding()メソッドの型。
 * テストでモック可能にするためインターフェースとして定義。
 *
 * Type for the generateEmbedding() method provided by e5-base EmbeddingService.
 * Defined as interface to allow mocking in tests.
 */
export interface EmbeddingServiceLike {
  generateEmbedding(text: string, type: "query" | "passage"): Promise<number[]>;
}

// ============================================================================
// Text Representation / テキスト表現
// ============================================================================

/**
 * テキスト表現に含めるスタイルプロパティ
 * Style properties to include in text representation
 */
const TEXT_REPR_STYLE_KEYS = [
  "background-color",
  "background",
  "color",
  "font-size",
  "font-weight",
  "font-family",
  "border-radius",
  "box-shadow",
  "border",
  "padding",
  "margin",
  "display",
  "gap",
  "opacity",
] as const;

/**
 * テキスト表現に含める属性キー
 * Attribute keys to include in text representation
 */
const TEXT_REPR_ATTRIBUTE_KEYS = [
  "alt",
  "placeholder",
  "aria-label",
  "title",
  "type",
  "role",
] as const;

/**
 * CSSクラスの最大数（テキスト表現に含める上限）
 * Maximum CSS classes to include in text representation
 */
const MAX_CSS_CLASSES_IN_TEXT = 10;

/**
 * コンポーネントパーツからe5-base用テキスト表現を構築する
 * Build text representation from a ComponentPart for e5-base embedding
 *
 * partType、partSubtype、スタイル、CSSクラス、属性、インタラクション情報を
 * テキストに変換し、"passage: " プレフィックスを付加。
 *
 * Converts partType, partSubtype, styles, CSS classes, attributes, and
 * interaction info to text with "passage: " prefix for e5-base format.
 *
 * @param part - Embedding生成対象のパーツ / Part for embedding generation
 * @returns "passage: " プレフィックス付きテキスト表現 / Text representation with "passage: " prefix
 */
export function buildPartTextRepresentation(part: ComponentPartForEmbedding): string {
  const segments: string[] = [];

  // 1. パーツタイプ / Part type
  segments.push(`type:${part.partType}`);
  if (part.partSubtype) {
    segments.push(`subtype:${part.partSubtype}`);
  }

  // 2. スタイル情報 / Style information
  const styleSegments: string[] = [];
  for (const key of TEXT_REPR_STYLE_KEYS) {
    const value = part.computedStyles[key];
    if (value && value !== "" && value !== "none" && value !== "initial") {
      styleSegments.push(`${key}:${value}`);
    }
  }
  if (styleSegments.length > 0) {
    segments.push(`styles:[${styleSegments.join(", ")}]`);
  }

  // 3. CSSクラス（最大10件） / CSS classes (max 10)
  if (part.cssClasses.length > 0) {
    const classes = part.cssClasses.slice(0, MAX_CSS_CLASSES_IN_TEXT);
    segments.push(`classes:[${classes.join(", ")}]`);
  }

  // 4. 属性情報 / Attribute information
  const attrSegments: string[] = [];
  for (const key of TEXT_REPR_ATTRIBUTE_KEYS) {
    const value = part.attributes[key];
    if (value && value !== "") {
      attrSegments.push(`${key}:${value}`);
    }
  }
  if (attrSegments.length > 0) {
    segments.push(`attrs:[${attrSegments.join(", ")}]`);
  }

  // 5. インタラクション情報 / Interaction information
  const activeInteractions: string[] = [];
  for (const [key, value] of Object.entries(part.interactionInfo)) {
    if (value === true) {
      activeInteractions.push(key);
    }
  }
  if (activeInteractions.length > 0) {
    segments.push(`interaction:[${activeInteractions.join(", ")}]`);
  }

  // e5-base format: "passage: " prefix
  return `passage: ${segments.join(" ")}`;
}

// ============================================================================
// Embedding Validation / Embedding検証
// ============================================================================

/**
 * EmbeddingベクトルのNaN/Infinity検証 [H-3]
 * Validate embedding vector for NaN/Infinity [H-3]
 *
 * @param embedding - 検証対象のEmbeddingベクトル / Embedding vector to validate
 * @param label - エラーメッセージ用ラベル / Label for error messages
 * @throws {Error} NaN/Infinityが検出された場合 / When NaN/Infinity is detected
 */
function validateEmbeddingFinite(embedding: number[], label: string): void {
  if (embedding.some((v) => !Number.isFinite(v))) {
    throw new Error(`Invalid ${label} embedding: contains NaN or Infinity`);
  }
}

/**
 * ゼロベクトル検証 [H-3]
 * Validate against zero vector [H-3]
 *
 * @param embedding - 検証対象のEmbeddingベクトル / Embedding vector to validate
 * @param label - エラーメッセージ用ラベル / Label for error messages
 * @throws {Error} ゼロベクトルが検出された場合 / When zero vector is detected
 */
function validateNotZeroVector(embedding: number[], label: string): void {
  const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) {
    throw new Error(`Invalid ${label} embedding: zero vector (L2 norm is 0)`);
  }
}

// ============================================================================
// Embedding Generation / Embedding生成
// ============================================================================

/**
 * DINOv2ビジュアルEmbeddingを生成する
 * Generate DINOv2 visual embedding for a part's crop buffer
 *
 * - 224x224 RGB cropBufferを受け取る
 * - DINOv2Service.generateEmbedding() で768D L2正規化ベクトルを生成
 * - NaN/Infinity検証 [H-3]
 * - ゼロベクトル検証 [H-3]
 *
 * @param dinov2Service - DINOv2サービスインスタンス / DINOv2 service instance
 * @param cropBuffer - 224x224x3 RGB画像バッファ / 224x224x3 RGB image buffer
 * @returns 768次元L2正規化ベクトル / 768-dimensional L2-normalized vector
 * @throws {Error} NaN/Infinity/ゼロベクトルが検出された場合 / When NaN/Infinity/zero vector detected
 */
export async function generateVisualEmbedding(
  dinov2Service: DINOv2Service,
  cropBuffer: Buffer
): Promise<number[]> {
  const embedding = await dinov2Service.generateEmbedding(cropBuffer);

  // [H-3] NaN/Infinity検証
  validateEmbeddingFinite(embedding, "visual");

  // [H-3] ゼロベクトル検証
  validateNotZeroVector(embedding, "visual");

  // DINOv2Serviceは既にL2正規化を行うが、次元数の検証
  if (embedding.length !== DINOV2_EMBEDDING_DIMENSION) {
    throw new Error(
      `Visual embedding dimension mismatch: expected ${DINOV2_EMBEDDING_DIMENSION}, got ${embedding.length}`
    );
  }

  return embedding;
}

/**
 * e5-baseテキストEmbeddingを生成する
 * Generate e5-base text embedding for a part's text representation
 *
 * - buildPartTextRepresentation() でテキスト表現を構築済みの文字列を受け取る
 * - embeddingService.generateEmbedding() で768Dベクトルを生成
 * - NaN/Infinity検証 [H-3]
 *
 * @param embeddingService - e5-base EmbeddingService / e5-base EmbeddingService
 * @param textRepresentation - "passage: " プレフィックス付きテキスト表現 / Text representation with "passage: " prefix
 * @returns 768次元ベクトル / 768-dimensional vector
 * @throws {Error} NaN/Infinityが検出された場合 / When NaN/Infinity detected
 */
export async function generateTextEmbedding(
  embeddingService: EmbeddingServiceLike,
  textRepresentation: string
): Promise<number[]> {
  // textRepresentation は既に "passage: " プレフィックス付き。
  // EmbeddingService.generateEmbedding() は内部でプレフィックスを付加するため、
  // プレフィックスなしのテキストを渡す。
  //
  // textRepresentation already has "passage: " prefix.
  // EmbeddingService.generateEmbedding() adds prefix internally,
  // so pass text without the prefix.
  const textWithoutPrefix = textRepresentation.startsWith("passage: ")
    ? textRepresentation.slice("passage: ".length)
    : textRepresentation;

  const embedding = await embeddingService.generateEmbedding(textWithoutPrefix, "passage");

  // [H-3] NaN/Infinity検証
  validateEmbeddingFinite(embedding, "text");

  return embedding;
}

/**
 * パーツのバッチEmbedding生成
 * Batch embedding generation for parts
 *
 * - OOM防止のため逐次処理（forループ）
 * - cropBufferがないパーツはビジュアルEmbeddingをスキップ
 * - chunkSizeごとにログ出力
 *
 * @param parts - cropBuffer付きパーツ一覧 / Parts with crop buffers
 * @param dinov2Service - DINOv2サービス / DINOv2 service
 * @param embeddingService - e5-base EmbeddingService / e5-base EmbeddingService
 * @param options - オプション / Options
 * @returns Embedding生成結果一覧 / Embedding generation results
 */
export async function generatePartEmbeddings(
  parts: ComponentPartWithCrop[],
  dinov2Service: DINOv2Service,
  embeddingService: EmbeddingServiceLike,
  options?: { chunkSize?: number }
): Promise<PartEmbeddingResult[]> {
  const chunkSize = options?.chunkSize ?? 5;
  const results: PartEmbeddingResult[] = [];

  if (parts.length === 0) {
    return results;
  }

  logger.info("[part-embedding] Starting batch embedding generation", {
    totalParts: parts.length,
    chunkSize,
  });

  const startTime = Date.now();

  // 逐次処理（OOM防止のためPromise.allを使わない）
  // Sequential processing (no Promise.all to prevent OOM)
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;

    try {
      // 1. テキスト表現を構築 / Build text representation
      const textRepresentation = buildPartTextRepresentation(part);

      // 2. テキストEmbedding生成 / Generate text embedding
      const textEmbedding = await generateTextEmbedding(embeddingService, textRepresentation);

      // 3. ビジュアルEmbedding生成（cropBufferがある場合のみ）
      //    Generate visual embedding (only if cropBuffer exists)
      let visualEmbedding: number[] | null = null;
      if (part.cropBuffer !== null) {
        visualEmbedding = await generateVisualEmbedding(dinov2Service, part.cropBuffer);
      }

      results.push({
        componentPartId: part.id,
        visualEmbedding,
        textEmbedding,
        textRepresentation,
      });

      // chunkSizeごとに進捗ログ / Progress log every chunkSize
      if ((i + 1) % chunkSize === 0 || i === parts.length - 1) {
        logger.info("[part-embedding] Batch progress", {
          completed: i + 1,
          total: parts.length,
          elapsedMs: Date.now() - startTime,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.warn("[part-embedding] Failed to generate embedding for part", {
        partId: truncateId(part.id),
        partType: part.partType,
        index: i,
        error: errorMessage,
      });
      // 部分失敗は継続（Graceful Degradation）
      // Continue on partial failure (Graceful Degradation)
    }
  }

  const durationMs = Date.now() - startTime;
  logger.info("[part-embedding] Batch embedding generation complete", {
    totalParts: parts.length,
    successCount: results.length,
    failedCount: parts.length - results.length,
    durationMs,
  });

  return results;
}
