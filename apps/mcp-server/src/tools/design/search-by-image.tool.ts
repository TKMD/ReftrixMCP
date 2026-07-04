// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * design.search_by_image MCPツール
 * 画像入力（Base64/URL）から視覚的に類似したデザインセクションを検索
 *
 * 機能:
 * - 画像→DINOv2 768D visual embedding変換
 * - vision_embedding HNSW検索（section_embeddings.vision_embedding）
 * - RRF 3-source融合: text(40%) + vision(30%) + fulltext(30%)（textクエリ指定時）
 * - テキストクエリなし: vision(100%)のみ
 *
 * セキュリティ:
 * - 画像URL: SSRF防止（validateExternalUrl使用）
 * - Base64: サイズ制限（10MB max）
 * - NaN/Infinity防御
 *
 * @module tools/design/search-by-image.tool
 */

import { z } from "zod";
import sharp from "sharp";
import { createDIFactory } from "../../utils/di-factory";
import { logger } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { validateExternalUrl } from "../../utils/url-validator";
import { DINOV2_INPUT_SIZE } from "@reftrixmcp/ml/dinov2";
import { createHash } from "node:crypto";
import {
  generateCacheKey,
  getCachedResult,
  setCachedResult,
} from "../../services/search-cache.service";

// =====================================================
// 定数
// =====================================================

/**
 * Base64入力の最大デコード後バイトサイズ（10MB）。
 * SEC-W3-M2: 内部 read API の `imageSearchBodySchema` がこの値を import し、char-level の
 * Zod 上限 (`MAX_BASE64_CHARS = ceil(bytes*4/3)`) を導出する単一の真実の源泉 (SSOT)。
 * MCP tool 経路 (本ファイル) と内部 API 経路が同一 cap を共有する (magic number 二重定義の排除)。
 *
 * Decoded-byte cap for base64 image input (10MB). SEC-W3-M2: the internal read API's
 * `imageSearchBodySchema` imports this value as the single source of truth, deriving its
 * char-level Zod cap (`MAX_BASE64_CHARS`). The MCP-tool path (this file) and the internal-API
 * path share ONE cap (no duplicated magic number).
 */
export const MAX_BASE64_BYTES = 10 * 1024 * 1024;

/** RRFのkパラメータ（既存設定と統一） */
const RRF_K = 60;

/** 画像URL取得のタイムアウト（ms） */
const IMAGE_FETCH_TIMEOUT_MS = 15_000;

/**
 * 画像URL取得時に追従を許可する最大リダイレクト hop 数（SEC-W3-H2 / CWE-918）。
 * `redirect:"manual"` で各 3xx の Location header を再度 `validateExternalUrl` で検証し、
 * private IP / metadata endpoint への 302 リダイレクト到達を構造的に reject する。
 *
 * Max redirect hops allowed when fetching an image URL (SEC-W3-H2 / CWE-918). With
 * `redirect:"manual"`, each 3xx Location header is re-validated via `validateExternalUrl`,
 * structurally rejecting a 302 redirect to a private IP / metadata endpoint.
 */
const MAX_IMAGE_REDIRECT_HOPS = 3;

// =====================================================
// 入力スキーマ
// =====================================================

export const designSearchByImageInputSchema = z.object({
  image: z
    .string()
    .min(1)
    .describe(
      "Base64エンコードされた画像データ（data:image/...;base64,... 形式も可）またはHTTPS画像URL"
    ),
  query: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("オプションのテキストクエリ（ハイブリッド検索用、日本語/英語対応）"),
  limit: z.number().int().min(1).max(50).default(10).describe("取得件数（1-50、デフォルト: 10）"),
  min_similarity: z
    .number()
    .min(0)
    .max(1)
    .default(0.3)
    .describe("最小類似度閾値（0-1、デフォルト: 0.3）"),
  section_type: z
    .string()
    .optional()
    .describe("セクションタイプフィルタ（hero, feature, cta, testimonial, pricing, footer等）"),
});

export type DesignSearchByImageInput = z.infer<typeof designSearchByImageInputSchema>;

// =====================================================
// 出力型
// =====================================================

export interface DesignSearchResultItem {
  id: string;
  webPageId: string;
  sectionType: string;
  sectionName?: string | undefined;
  similarity: number;
  visionSimilarity?: number | undefined;
  textSimilarity?: number | undefined;
  webPage: {
    id: string;
    url: string;
    title?: string | undefined;
    sourceType: string;
    screenshotDesktopUrl: string | null;
  };
}

export interface DesignSearchByImageOutput {
  success: boolean;
  results: DesignSearchResultItem[];
  total: number;
  searchMode: "vision_only" | "hybrid_rrf";
  /** 画像からembeddingを生成した際の処理時間（ms） */
  embeddingTimeMs?: number;
  error?: string;
}

// =====================================================
// エラーコード
// =====================================================

export const DESIGN_SEARCH_ERROR_CODES = {
  INVALID_INPUT: "INVALID_INPUT",
  IMAGE_TOO_LARGE: "IMAGE_TOO_LARGE",
  SSRF_BLOCKED: "SSRF_BLOCKED",
  IMAGE_FETCH_FAILED: "IMAGE_FETCH_FAILED",
  IMAGE_DECODE_FAILED: "IMAGE_DECODE_FAILED",
  EMBEDDING_FAILED: "EMBEDDING_FAILED",
  SEARCH_FAILED: "SEARCH_FAILED",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

// =====================================================
// DI ファクトリー
// =====================================================

export interface IDesignSearchDINOv2Service {
  initialize(): Promise<void>;
  generateEmbedding(imageBuffer: Buffer): Promise<number[]>;
  dispose(): Promise<void>;
  readonly initialized: boolean;
}

export interface IDesignSearchEmbeddingService {
  generateEmbedding(text: string, type: "query" | "passage"): Promise<number[] | null>;
}

export interface IDesignSearchPrismaClient {
  $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
}

const dinov2ServiceDI = createDIFactory<IDesignSearchDINOv2Service>("DesignSearchDINOv2Service");
const embeddingServiceDI = createDIFactory<IDesignSearchEmbeddingService>(
  "DesignSearchEmbeddingService"
);
const prismaClientDI = createDIFactory<IDesignSearchPrismaClient>("DesignSearchPrismaClient");

export const setDesignSearchDINOv2ServiceFactory = dinov2ServiceDI.set;
export const resetDesignSearchDINOv2ServiceFactory = dinov2ServiceDI.reset;
export const setDesignSearchEmbeddingServiceFactory = embeddingServiceDI.set;
export const resetDesignSearchEmbeddingServiceFactory = embeddingServiceDI.reset;
export const setDesignSearchPrismaClientFactory = prismaClientDI.set;
export const resetDesignSearchPrismaClientFactory = prismaClientDI.reset;

// =====================================================
// ヘルパー関数
// =====================================================

/**
 * RRFスコアを計算
 * @param rank 1-indexed ランク
 */
function calculateRRFScore(rank: number): number {
  return 1 / (RRF_K + rank);
}

/**
 * 入力が画像URLかBase64かを判定
 */
function isImageUrl(image: string): boolean {
  return image.startsWith("http://") || image.startsWith("https://");
}

/**
 * Base64データからバイナリBufferを抽出
 * data:image/png;base64,... 形式もサポート
 */
function decodeBase64Image(input: string): Buffer {
  // data URI形式の場合、base64部分のみ抽出
  let base64Data = input;
  if (input.startsWith("data:")) {
    const commaIndex = input.indexOf(",");
    if (commaIndex === -1) {
      throw new Error("Invalid data URI format: missing comma separator");
    }
    base64Data = input.substring(commaIndex + 1);
  }

  const buffer = Buffer.from(base64Data, "base64");

  // サイズ検証
  if (buffer.length > MAX_BASE64_BYTES) {
    throw new Error(
      `Image size ${(buffer.length / 1024 / 1024).toFixed(1)}MB exceeds maximum ${MAX_BASE64_BYTES / 1024 / 1024}MB`
    );
  }

  if (buffer.length === 0) {
    throw new Error("Decoded image is empty (0 bytes)");
  }

  return buffer;
}

/**
 * 単一 hop の fetch を `redirect:"manual"` で実行（自動追従禁止、SEC-W3-H2 / CWE-918）。
 * 3xx は追従せず raw response を返す（呼び出し側が Location を再検証する）。
 *
 * Performs a single-hop fetch with `redirect:"manual"` (no auto-follow). 3xx responses are
 * returned raw so the caller can re-validate the Location header (SEC-W3-H2 / CWE-918).
 */
async function fetchImageHopManual(safeUrl: string): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    return await fetch(safeUrl, {
      // CWE-918: never auto-follow — a 302 to 169.254.169.254 would bypass the initial gate.
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent": "Reftrix/1.0 (design-search)",
        Accept: "image/*",
      },
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 3xx の Location header を解決し（相対 URL は base に対して解決）、再度 SSRF 検証して
 * 次 hop の安全な URL を返す（SEC-W3-H2）。Location 欠落 / 検証失敗は throw。
 *
 * Resolves a 3xx Location header (relative URLs against the base), re-validates it via
 * `validateExternalUrl`, and returns the next safe hop URL (SEC-W3-H2). A missing Location or
 * a validation failure throws (no silent SSRF bypass).
 */
function resolveRedirectTarget(response: Response, baseUrl: string): string {
  const location = response.headers.get("location");
  if (!location) {
    throw new Error(`Redirect ${response.status} without a Location header`);
  }
  // 相対 Location を base に対して絶対化してから検証（host のみの partial も解決）。
  let absolute: string;
  try {
    absolute = new URL(location, baseUrl).toString();
  } catch {
    throw new Error("Redirect target is not a valid URL");
  }
  // CWE-918: each redirect target is re-validated against the SSRF gate (private IP / metadata).
  const validation = validateExternalUrl(absolute);
  if (!validation.valid) {
    throw new Error(`SSRF blocked (redirect): ${validation.error}`);
  }
  return validation.normalizedUrl ?? absolute;
}

/**
 * 2xx 画像 response を検証して Buffer を返す（content-type image/* + size cap、CWE-770）。
 * Validates a 2xx image response and returns its Buffer (content-type + size cap).
 */
async function readImageResponse(response: Response): Promise<Buffer> {
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    throw new Error(`Invalid content-type: ${contentType} (expected image/*)`);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BASE64_BYTES) {
    throw new Error(`Image size exceeds maximum ${MAX_BASE64_BYTES / 1024 / 1024}MB`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_BASE64_BYTES) {
    throw new Error(
      `Image size ${(buffer.length / 1024 / 1024).toFixed(1)}MB exceeds maximum ${MAX_BASE64_BYTES / 1024 / 1024}MB`
    );
  }
  return buffer;
}

/**
 * 画像URLからバイナリBufferを取得（SSRF検証付き、redirect:"manual" で各 hop を再検証）。
 *
 * SEC-W3-H2 / CWE-918: 初回 URL を `validateExternalUrl` で検証 → `redirect:"manual"` で
 * fetch → 3xx なら Location を再検証して次 hop（最大 {@link MAX_IMAGE_REDIRECT_HOPS} hop）。
 * 自動追従しないため 302→metadata endpoint への到達は構造的に不可能。
 *
 * Fetches an image URL with SSRF validation, re-validating every redirect hop. The initial URL
 * is gated by `validateExternalUrl`; the fetch uses `redirect:"manual"`, and each 3xx Location
 * is re-validated before the next hop (up to {@link MAX_IMAGE_REDIRECT_HOPS}). Auto-follow is
 * never used, so reaching a metadata endpoint via a 302 is structurally impossible.
 */
async function fetchImageFromUrl(url: string): Promise<Buffer> {
  const validation = validateExternalUrl(url);
  if (!validation.valid) {
    throw new Error(`SSRF blocked: ${validation.error}`);
  }
  let currentUrl = validation.normalizedUrl ?? url;

  for (let hop = 0; hop <= MAX_IMAGE_REDIRECT_HOPS; hop++) {
    const response = await fetchImageHopManual(currentUrl);
    // 3xx (with a Location header) = a redirect to re-validate; otherwise read as the image.
    const isRedirect = response.status >= 300 && response.status < 400;
    if (!isRedirect) {
      return await readImageResponse(response);
    }
    currentUrl = resolveRedirectTarget(response, currentUrl);
  }
  throw new Error(`Too many redirects (>${MAX_IMAGE_REDIRECT_HOPS})`);
}

/**
 * 画像バッファをDINOv2入力形式（224x224x3 RGB）にリサイズ
 */
async function preprocessImageForDINOv2(imageBuffer: Buffer): Promise<Buffer> {
  const resized = await sharp(imageBuffer)
    .resize(DINOV2_INPUT_SIZE, DINOV2_INPUT_SIZE, {
      fit: "fill",
      position: "center",
    })
    .removeAlpha()
    .raw()
    .toBuffer();

  const expectedSize = DINOV2_INPUT_SIZE * DINOV2_INPUT_SIZE * 3;
  if (resized.length !== expectedSize) {
    throw new Error(
      `Preprocessed image size mismatch: expected ${expectedSize}, got ${resized.length}`
    );
  }

  return resized;
}

// =====================================================
// DB検索ヘルパー
// =====================================================

interface VisionSearchRecord {
  id: string;
  web_page_id: string;
  section_type: string;
  section_name: string | null;
  similarity: number;
  wp_id: string;
  wp_url: string;
  wp_title: string | null;
  wp_source_type: string;
  wp_screenshot_desktop_url: string | null;
}

/**
 * vision_embedding でHNSW検索
 */
async function searchByVisionEmbedding(
  prisma: IDesignSearchPrismaClient,
  visionEmbedding: number[],
  limit: number,
  minSimilarity: number,
  sectionType?: string
): Promise<DesignSearchResultItem[]> {
  const vectorString = `[${visionEmbedding.join(",")}]`;
  const params: unknown[] = [];
  let paramIndex = 1;

  // WHERE句構築
  const conditions: string[] = ["se.vision_embedding IS NOT NULL"];

  if (sectionType) {
    conditions.push(`sp.section_type = $${paramIndex}`);
    params.push(sectionType);
    paramIndex++;
  }

  const vectorParamIndex = paramIndex;
  params.push(vectorString);
  paramIndex++;

  const limitParamIndex = paramIndex;
  params.push(limit);

  const whereClause = conditions.join(" AND ");

  const query = `
    SELECT
      sp.id,
      sp.web_page_id,
      sp.section_type,
      sp.section_name,
      1 - (se.vision_embedding <=> $${vectorParamIndex}::vector) as similarity,
      wp.id as wp_id,
      wp.url as wp_url,
      wp.title as wp_title,
      wp.source_type as wp_source_type,
      wp.screenshot_desktop_url as wp_screenshot_desktop_url
    FROM section_patterns sp
    INNER JOIN section_embeddings se ON se.section_pattern_id = sp.id
    INNER JOIN web_pages wp ON wp.id = sp.web_page_id
    WHERE ${whereClause}
    ORDER BY similarity DESC
    LIMIT $${limitParamIndex}
  `;

  const records = await prisma.$queryRawUnsafe<VisionSearchRecord[]>(query, ...params);

  return records
    .filter((r) => r.similarity >= minSimilarity)
    .map((r) => ({
      id: r.id,
      webPageId: r.web_page_id,
      sectionType: r.section_type,
      sectionName: r.section_name ?? undefined,
      similarity: r.similarity,
      visionSimilarity: r.similarity,
      webPage: {
        id: r.wp_id,
        url: r.wp_url,
        title: r.wp_title ?? undefined,
        sourceType: r.wp_source_type,
        screenshotDesktopUrl: r.wp_screenshot_desktop_url,
      },
    }));
}

/**
 * text_embedding でベクトル検索
 */
async function searchByTextEmbedding(
  prisma: IDesignSearchPrismaClient,
  textEmbedding: number[],
  limit: number,
  sectionType?: string
): Promise<DesignSearchResultItem[]> {
  const vectorString = `[${textEmbedding.join(",")}]`;
  const params: unknown[] = [];
  let paramIndex = 1;

  const conditions: string[] = ["se.text_embedding IS NOT NULL"];

  if (sectionType) {
    conditions.push(`sp.section_type = $${paramIndex}`);
    params.push(sectionType);
    paramIndex++;
  }

  const vectorParamIndex = paramIndex;
  params.push(vectorString);
  paramIndex++;

  const limitParamIndex = paramIndex;
  params.push(limit);

  const whereClause = conditions.join(" AND ");

  const query = `
    SELECT
      sp.id,
      sp.web_page_id,
      sp.section_type,
      sp.section_name,
      1 - (se.text_embedding <=> $${vectorParamIndex}::vector) as similarity,
      wp.id as wp_id,
      wp.url as wp_url,
      wp.title as wp_title,
      wp.source_type as wp_source_type,
      wp.screenshot_desktop_url as wp_screenshot_desktop_url
    FROM section_patterns sp
    INNER JOIN section_embeddings se ON se.section_pattern_id = sp.id
    INNER JOIN web_pages wp ON wp.id = sp.web_page_id
    WHERE ${whereClause}
    ORDER BY similarity DESC
    LIMIT $${limitParamIndex}
  `;

  const records = await prisma.$queryRawUnsafe<VisionSearchRecord[]>(query, ...params);

  return records.map((r) => ({
    id: r.id,
    webPageId: r.web_page_id,
    sectionType: r.section_type,
    sectionName: r.section_name ?? undefined,
    similarity: r.similarity,
    textSimilarity: r.similarity,
    webPage: {
      id: r.wp_id,
      url: r.wp_url,
      title: r.wp_title ?? undefined,
      sourceType: r.wp_source_type,
      screenshotDesktopUrl: r.wp_screenshot_desktop_url,
    },
  }));
}

/**
 * 全文検索（tsvector）
 */
async function searchByFulltext(
  prisma: IDesignSearchPrismaClient,
  queryText: string,
  limit: number,
  sectionType?: string
): Promise<DesignSearchResultItem[]> {
  const params: unknown[] = [];
  let paramIndex = 1;

  const conditions: string[] = ["sp.search_vector IS NOT NULL"];

  if (sectionType) {
    conditions.push(`sp.section_type = $${paramIndex}`);
    params.push(sectionType);
    paramIndex++;
  }

  const queryParamIndex = paramIndex;
  params.push(queryText);
  paramIndex++;

  const limitParamIndex = paramIndex;
  params.push(limit);

  const whereClause = conditions.join(" AND ");

  const query = `
    SELECT
      sp.id,
      sp.web_page_id,
      sp.section_type,
      sp.section_name,
      ts_rank(sp.search_vector, plainto_tsquery('simple', $${queryParamIndex})) as similarity,
      wp.id as wp_id,
      wp.url as wp_url,
      wp.title as wp_title,
      wp.source_type as wp_source_type,
      wp.screenshot_desktop_url as wp_screenshot_desktop_url
    FROM section_patterns sp
    INNER JOIN web_pages wp ON wp.id = sp.web_page_id
    WHERE ${whereClause}
      AND sp.search_vector @@ plainto_tsquery('simple', $${queryParamIndex})
    ORDER BY similarity DESC
    LIMIT $${limitParamIndex}
  `;

  const records = await prisma.$queryRawUnsafe<VisionSearchRecord[]>(query, ...params);

  return records.map((r) => ({
    id: r.id,
    webPageId: r.web_page_id,
    sectionType: r.section_type,
    sectionName: r.section_name ?? undefined,
    similarity: r.similarity,
    webPage: {
      id: r.wp_id,
      url: r.wp_url,
      title: r.wp_title ?? undefined,
      sourceType: r.wp_source_type,
      screenshotDesktopUrl: r.wp_screenshot_desktop_url,
    },
  }));
}

/**
 * RRF 3-source融合
 * text(40%) + vision(30%) + fulltext(30%)
 */
function mergeWithRRF3Source(
  textResults: DesignSearchResultItem[],
  visionResults: DesignSearchResultItem[],
  fulltextResults: DesignSearchResultItem[],
  weights: { text: number; vision: number; fulltext: number }
): DesignSearchResultItem[] {
  const scoreMap = new Map<
    string,
    { result: DesignSearchResultItem; score: number; visionSim?: number; textSim?: number }
  >();

  // Text embedding RRFスコア
  textResults.forEach((result, index) => {
    const rrfScore = calculateRRFScore(index + 1) * weights.text;
    const existing = scoreMap.get(result.id);
    if (existing) {
      existing.score += rrfScore;
      existing.textSim = result.similarity;
    } else {
      scoreMap.set(result.id, { result, score: rrfScore, textSim: result.similarity });
    }
  });

  // Vision embedding RRFスコア
  visionResults.forEach((result, index) => {
    const rrfScore = calculateRRFScore(index + 1) * weights.vision;
    const existing = scoreMap.get(result.id);
    if (existing) {
      existing.score += rrfScore;
      existing.visionSim = result.similarity;
    } else {
      scoreMap.set(result.id, { result, score: rrfScore, visionSim: result.similarity });
    }
  });

  // Fulltext RRFスコア
  fulltextResults.forEach((result, index) => {
    const rrfScore = calculateRRFScore(index + 1) * weights.fulltext;
    const existing = scoreMap.get(result.id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scoreMap.set(result.id, { result, score: rrfScore });
    }
  });

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .map(({ result, score, visionSim, textSim }) => ({
      ...result,
      similarity: score,
      visionSimilarity: visionSim,
      textSimilarity: textSim,
    }));
}

// =====================================================
// ハンドラー
// =====================================================

/**
 * design.search_by_image ハンドラー
 */
export async function designSearchByImageHandler(
  input: unknown
): Promise<DesignSearchByImageOutput> {
  const startTime = Date.now();

  // 入力バリデーション
  let parsed: DesignSearchByImageInput;
  try {
    parsed = designSearchByImageInputSchema.parse(input);
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")
        : "Invalid input";
    return {
      success: false,
      results: [],
      total: 0,
      searchMode: "vision_only",
      error: `${DESIGN_SEARCH_ERROR_CODES.INVALID_INPUT}: ${message}`,
    };
  }

  // DINOv2サービス取得
  const dinov2Factory = dinov2ServiceDI.get();
  if (!dinov2Factory) {
    return {
      success: false,
      results: [],
      total: 0,
      searchMode: "vision_only",
      error: `${DESIGN_SEARCH_ERROR_CODES.SERVICE_UNAVAILABLE}: DINOv2 service not available`,
    };
  }

  // Prismaクライアント取得
  const prismaFactory = prismaClientDI.get();
  if (!prismaFactory) {
    return {
      success: false,
      results: [],
      total: 0,
      searchMode: "vision_only",
      error: `${DESIGN_SEARCH_ERROR_CODES.SERVICE_UNAVAILABLE}: Database not available`,
    };
  }

  const dinov2 = dinov2Factory();
  const prisma = prismaFactory();

  // キャッシュチェック / Cache check
  // Base64画像データ（最大10MB）のJSON.stringify CPUコスト回避のため、
  // imageフィールドのみSHA-256ダイジェストに置換してキャッシュキーを生成
  const imageDigest = createHash("sha256").update(parsed.image).digest("hex");
  const cacheKeyParams = { ...parsed, image: imageDigest } as unknown as Record<string, unknown>;
  const cacheKey = generateCacheKey("design.search_by_image", cacheKeyParams);
  const cachedResult = getCachedResult<DesignSearchByImageOutput>(cacheKey);
  if (cachedResult) {
    return cachedResult;
  }

  try {
    // ステップ1: 画像取得（URL or Base64）
    let imageBuffer: Buffer;
    try {
      if (isImageUrl(parsed.image)) {
        imageBuffer = await fetchImageFromUrl(parsed.image);
      } else {
        imageBuffer = decodeBase64Image(parsed.image);
      }
    } catch (error) {
      const code = isImageUrl(parsed.image)
        ? parsed.image.includes("blocked")
          ? DESIGN_SEARCH_ERROR_CODES.SSRF_BLOCKED
          : DESIGN_SEARCH_ERROR_CODES.IMAGE_FETCH_FAILED
        : DESIGN_SEARCH_ERROR_CODES.IMAGE_DECODE_FAILED;
      return {
        success: false,
        results: [],
        total: 0,
        searchMode: "vision_only",
        error: `${code}: ${sanitizeErrorMessage(error)}`,
      };
    }

    // ステップ2: 画像前処理（224x224x3 RGB）
    let preprocessedBuffer: Buffer;
    try {
      preprocessedBuffer = await preprocessImageForDINOv2(imageBuffer);
    } catch (error) {
      return {
        success: false,
        results: [],
        total: 0,
        searchMode: "vision_only",
        error: `${DESIGN_SEARCH_ERROR_CODES.IMAGE_DECODE_FAILED}: ${sanitizeErrorMessage(error)}`,
      };
    }

    // ステップ3: DINOv2でvisual embedding生成
    const embeddingStartTime = Date.now();
    let visionEmbedding: number[];
    try {
      if (!dinov2.initialized) {
        await dinov2.initialize();
      }
      visionEmbedding = await dinov2.generateEmbedding(preprocessedBuffer);

      // NaN/Infinity防御
      if (visionEmbedding.some((v) => !Number.isFinite(v))) {
        throw new Error("Generated embedding contains NaN or Infinity");
      }
    } catch (error) {
      return {
        success: false,
        results: [],
        total: 0,
        searchMode: "vision_only",
        error: `${DESIGN_SEARCH_ERROR_CODES.EMBEDDING_FAILED}: ${sanitizeErrorMessage(error)}`,
      };
    }
    const embeddingTimeMs = Date.now() - embeddingStartTime;

    // ステップ4: 検索実行
    const fetchLimit = parsed.limit * 3; // RRF用に多めに取得

    if (parsed.query) {
      // ハイブリッドRRF 3-source検索
      const embeddingFactory = embeddingServiceDI.get();
      if (!embeddingFactory) {
        // e5-baseが利用不可の場合、visionのみで検索
        logger.warn(
          "[design.search_by_image] EmbeddingService not available, falling back to vision-only"
        );
        const visionResults = await searchByVisionEmbedding(
          prisma,
          visionEmbedding,
          parsed.limit,
          parsed.min_similarity,
          parsed.section_type
        );

        const fallbackResult: DesignSearchByImageOutput = {
          success: true,
          results: visionResults,
          total: visionResults.length,
          searchMode: "vision_only",
          embeddingTimeMs,
        };
        setCachedResult(cacheKey, fallbackResult);
        return fallbackResult;
      }

      const embeddingService = embeddingFactory();

      // テキストembedding生成（e5-base、query:プレフィックス付き）
      const textEmbedding = await embeddingService.generateEmbedding(
        `query: ${parsed.query}`,
        "query"
      );

      if (!textEmbedding) {
        // テキストembedding生成失敗時もvisionのみで検索
        logger.warn(
          "[design.search_by_image] Text embedding generation failed, falling back to vision-only"
        );
        const visionResults = await searchByVisionEmbedding(
          prisma,
          visionEmbedding,
          parsed.limit,
          parsed.min_similarity,
          parsed.section_type
        );

        const textFallbackResult: DesignSearchByImageOutput = {
          success: true,
          results: visionResults,
          total: visionResults.length,
          searchMode: "vision_only",
          embeddingTimeMs,
        };
        setCachedResult(cacheKey, textFallbackResult);
        return textFallbackResult;
      }

      // 3-source並列検索
      const [textResults, visionResults, fulltextResults] = await Promise.all([
        searchByTextEmbedding(prisma, textEmbedding, fetchLimit, parsed.section_type),
        searchByVisionEmbedding(
          prisma,
          visionEmbedding,
          fetchLimit,
          0, // RRF前なのでminSimilarityは適用しない
          parsed.section_type
        ),
        searchByFulltext(prisma, parsed.query, fetchLimit, parsed.section_type),
      ]);

      // RRF融合: text(40%) + vision(30%) + fulltext(30%)
      const merged = mergeWithRRF3Source(textResults, visionResults, fulltextResults, {
        text: 0.4,
        vision: 0.3,
        fulltext: 0.3,
      });

      // minSimilarity適用 + limit
      const filtered = merged
        .filter((r) => r.similarity >= parsed.min_similarity)
        .slice(0, parsed.limit);

      const hybridResult: DesignSearchByImageOutput = {
        success: true,
        results: filtered,
        total: filtered.length,
        searchMode: "hybrid_rrf",
        embeddingTimeMs,
      };
      setCachedResult(cacheKey, hybridResult);
      return hybridResult;
    } else {
      // Vision-only検索
      const visionResults = await searchByVisionEmbedding(
        prisma,
        visionEmbedding,
        parsed.limit,
        parsed.min_similarity,
        parsed.section_type
      );

      const visionOnlyResult: DesignSearchByImageOutput = {
        success: true,
        results: visionResults,
        total: visionResults.length,
        searchMode: "vision_only",
        embeddingTimeMs,
      };
      setCachedResult(cacheKey, visionOnlyResult);
      return visionOnlyResult;
    }
  } catch (error) {
    logger.warn("[design.search_by_image] Search failed", {
      error: sanitizeErrorMessage(error),
    });
    return {
      success: false,
      results: [],
      total: 0,
      searchMode: "vision_only",
      error: `${DESIGN_SEARCH_ERROR_CODES.SEARCH_FAILED}: ${sanitizeErrorMessage(error)}`,
    };
  } finally {
    logger.info("[design.search_by_image] completed", {
      processingTimeMs: Date.now() - startTime,
    });
  }
}

// =====================================================
// ツール定義
// =====================================================

export const designSearchByImageToolDefinition = {
  name: "design.search_by_image",
  description:
    "画像から視覚的に類似したデザインセクションを検索します。" +
    "Base64エンコード画像またはHTTPS画像URLを入力として受け付けます。" +
    "DINOv2 visual embeddingを使用したHNSW検索で類似デザインを発見します。" +
    "オプションのテキストクエリを指定すると、RRF 3-source融合（text 40% + vision 30% + fulltext 30%）でハイブリッド検索を実行します。",
  annotations: {
    title: "Design Search by Image",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      image: {
        type: "string",
        description:
          "Base64エンコードされた画像データ（data:image/...;base64,... 形式も可）またはHTTPS画像URL",
      },
      query: {
        type: "string",
        description: "オプションのテキストクエリ（ハイブリッド検索用、日本語/英語対応、1-500文字）",
        minLength: 1,
        maxLength: 500,
      },
      limit: {
        type: "number",
        description: "取得件数（1-50、デフォルト: 10）",
        minimum: 1,
        maximum: 50,
        default: 10,
      },
      min_similarity: {
        type: "number",
        description: "最小類似度閾値（0-1、デフォルト: 0.3）",
        minimum: 0,
        maximum: 1,
        default: 0.3,
      },
      section_type: {
        type: "string",
        description:
          "セクションタイプフィルタ（hero, feature, cta, testimonial, pricing, footer等）",
      },
    },
    required: ["image"],
  },
};
