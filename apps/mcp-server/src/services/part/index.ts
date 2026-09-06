// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Part-Level Analysis Service - Public API
 *
 * Webページ内の個別UIパーツ（ボタン、カード、ナビゲーション等）の
 * 型定義、Zodバリデーションスキーマ、抽出サービス、DB保存サービス、
 * Embedding生成サービスを提供する。
 *
 * Provides type definitions, Zod validation schemas, extraction service,
 * DB save service, and embedding generation service for individual UI parts
 * (buttons, cards, navigation, etc.) within web pages.
 *
 * @module services/part
 */

// Types
export * from "./types";

// Schemas
export * from "./schemas";

// Services - Extraction
export {
  extractPartsFromSection,
  identifyPartType,
  classifyPiiRisk,
  maskPiiInAttributes,
  clampExtractRegion,
  cropAndResizePart,
  computeVisualSignature,
  isLogoElement,
} from "./part-extraction.service";

// Services - DB Save
export { saveExtractedParts, type PartSaveResult } from "./part-db.service";

// Services - Embedding Generation
export {
  buildPartTextRepresentation,
  generateVisualEmbedding,
  generateTextEmbedding,
  generatePartEmbeddings,
  type ComponentPartForEmbedding,
  type ComponentPartWithCrop,
  type PartEmbeddingResult,
  type EmbeddingServiceLike,
} from "./part-embedding.service";

// Services - Embedding DB Save
export {
  savePartEmbeddings,
  type PartEmbeddingSaveResult,
  type PartEmbeddingPrismaClient,
} from "./part-embedding-db.service";

// Services - Backfill
export {
  backfillPartEmbeddings,
  type BackfillOptions,
  type BackfillResult,
} from "./part-backfill.service";

// Services - Search
export {
  PartSearchService,
  getPartSearchService,
  resetPartSearchService,
  createPartSearchServiceFactory,
  setPartSearchEmbeddingServiceFactory,
  resetPartSearchEmbeddingServiceFactory,
  setPartSearchPrismaClientFactory,
  resetPartSearchPrismaClientFactory,
  buildPartSearchWhereClause,
  type PartSearchServiceInterface,
  type PartSearchEmbeddingService,
  type PartSearchPrismaClient,
  type PartSearchOptions,
  type PartSearchResult,
  type PartSearchResultItem,
} from "./part-search.service";
