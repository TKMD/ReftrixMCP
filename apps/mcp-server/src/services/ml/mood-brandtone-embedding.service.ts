// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Mood/BrandTone Embedding Service
 *
 * SectionPattern の mood/brandTone 埋め込み生成サービス
 *
 * Phase 5-4: SectionEmbedding Extension for mood/brandTone
 *
 * 機能:
 * - generateMoodEmbedding: Mood テキスト表現 → 768D Embedding生成
 * - generateBrandToneEmbedding: BrandTone テキスト表現 → 768D Embedding生成
 * - バッチ処理対応
 * - DB保存（SectionEmbedding.mood_embedding / brand_tone_embedding）
 *
 * @module services/ml/mood-brandtone-embedding.service
 */

import { isDevelopment, logger } from '../../utils/logger';

// =====================================================
// 定数
// =====================================================

/** デフォルトのモデル名 */
export const DEFAULT_MODEL_NAME = 'multilingual-e5-base';

/** デフォルトのEmbedding次元数 */
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;

/** デフォルトのタイムアウト（ミリ秒） */
const DEFAULT_TIMEOUT_MS = 30000;

// =====================================================
// 型定義
// =====================================================

/**
 * Mood テキスト表現
 */
export interface MoodTextRepresentation {
  /** 主要なムード */
  primary: string;
  /** 副次的なムード */
  secondary: string;
  /** 説明 */
  description: string;
}

/**
 * BrandTone テキスト表現
 */
export interface BrandToneTextRepresentation {
  /** 主要なブランドトーン */
  primary: string;
  /** 副次的なブランドトーン */
  secondary: string;
  /** 説明 */
  description: string;
}

/**
 * MoodBrandToneEmbeddingServiceのオプション
 */
export interface MoodBrandToneEmbeddingOptions {
  /** モデル名（デフォルト: multilingual-e5-base） */
  modelName?: string;
  /** Embeddingの次元数（デフォルト: 768） */
  dimensions?: number;
  /** L2正規化するか（デフォルト: true） */
  normalize?: boolean;
  /** キャッシュを有効にするか（デフォルト: true） */
  cacheEnabled?: boolean;
  /** タイムアウト（ミリ秒、デフォルト: 30000） */
  timeout?: number;
}

/**
 * Mood/BrandTone Embedding生成結果
 */
export interface MoodBrandToneEmbeddingResult {
  /** 768次元ベクトル */
  embedding: number[];
  /** Embedding生成に使用したテキスト表現 */
  textRepresentation: string;
  /** 使用したモデル名 */
  modelName: string;
  /** 処理時間（ミリ秒） */
  processingTimeMs: number;
  /** タイプ（mood または brandTone） */
  type: 'mood' | 'brandTone';
}

/**
 * バッチ処理オプション
 */
export interface BatchOptions {
  /** 進捗コールバック */
  onProgress?: (completed: number, total: number) => void;
  /** エラー時に継続するか（デフォルト: true） */
  continueOnError?: boolean;
}

/**
 * キャッシュ統計
 */
export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  evictions: number;
}

// =====================================================
// EmbeddingService インターフェース（DI用）
// =====================================================

/**
 * EmbeddingServiceインターフェース
 */
export interface IEmbeddingService {
  generateEmbedding(text: string, type?: 'query' | 'passage'): Promise<number[]>;
  generateBatchEmbeddings(texts: string[], type?: 'query' | 'passage'): Promise<number[][]>;
  getCacheStats(): CacheStats;
  clearCache(): void;
}

// ファクトリ関数（テスト時のDI用）
let embeddingServiceFactory: (() => IEmbeddingService) | null = null;

/**
 * EmbeddingServiceファクトリを設定（テスト用）
 */
export function setEmbeddingServiceFactory(factory: () => IEmbeddingService): void {
  embeddingServiceFactory = factory;
}

/**
 * EmbeddingServiceファクトリをリセット（テスト用）
 */
export function resetEmbeddingServiceFactory(): void {
  embeddingServiceFactory = null;
}

// =====================================================
// Prisma Client インターフェース（DI用）
// =====================================================

/**
 * SectionEmbeddingデータ型
 */
export interface SectionEmbeddingData {
  id: string;
  sectionPatternId: string;
  textEmbedding?: number[];
  moodTextRepresentation?: string | null;
  moodEmbedding?: number[] | null;
  brandToneTextRepresentation?: string | null;
  brandToneEmbedding?: number[] | null;
}

/**
 * PrismaClientインターフェース（部分的）
 */
export interface IPrismaClient {
  sectionEmbedding: {
    create: (args: {
      data: {
        sectionPatternId: string;
        modelVersion?: string;
        textRepresentation?: string;
        moodTextRepresentation?: string;
        brandToneTextRepresentation?: string;
      };
    }) => Promise<SectionEmbeddingData>;
    update: (args: {
      where: { id?: string; sectionPatternId?: string };
      data: {
        moodTextRepresentation?: string;
        brandToneTextRepresentation?: string;
        modelVersion?: string;
      };
    }) => Promise<SectionEmbeddingData>;
    upsert: (args: {
      where: { sectionPatternId: string };
      create: {
        sectionPatternId: string;
        modelVersion?: string;
        textRepresentation?: string;
        moodTextRepresentation?: string;
        brandToneTextRepresentation?: string;
      };
      update: {
        moodTextRepresentation?: string;
        brandToneTextRepresentation?: string;
        modelVersion?: string;
      };
    }) => Promise<SectionEmbeddingData>;
    findUnique: (args: {
      where: { sectionPatternId: string };
    }) => Promise<SectionEmbeddingData | null>;
  };
  $transaction: <T>(fn: (tx: IPrismaClient) => Promise<T>) => Promise<T>;
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
}

// ファクトリ関数（テスト時のDI用）
let prismaClientFactory: (() => IPrismaClient) | null = null;

/**
 * PrismaClientファクトリを設定（テスト用）
 */
export function setPrismaClientFactory(factory: () => IPrismaClient): void {
  prismaClientFactory = factory;
}

/**
 * PrismaClientファクトリをリセット（テスト用）
 */
export function resetPrismaClientFactory(): void {
  prismaClientFactory = null;
}

/**
 * PrismaClientを取得
 */
function getPrismaClient(): IPrismaClient {
  if (prismaClientFactory) {
    return prismaClientFactory();
  }

  throw new Error('PrismaClient not initialized. Use setPrismaClientFactory in production.');
}

// =====================================================
// ヘルパー関数
// =====================================================

/**
 * Moodテキスト表現を生成
 */
function moodToText(mood: MoodTextRepresentation): string {
  const parts: string[] = [];

  if (mood.primary) {
    parts.push(`primary mood: ${mood.primary}`);
  }
  if (mood.secondary) {
    parts.push(`secondary mood: ${mood.secondary}`);
  }
  if (mood.description) {
    parts.push(`description: ${mood.description}`);
  }

  // e5モデル用にpassage:プレフィックスを付与
  return `passage: mood design. ${parts.join('. ')}.`;
}

/**
 * BrandToneテキスト表現を生成
 */
function brandToneToText(brandTone: BrandToneTextRepresentation): string {
  const parts: string[] = [];

  if (brandTone.primary) {
    parts.push(`primary brand tone: ${brandTone.primary}`);
  }
  if (brandTone.secondary) {
    parts.push(`secondary brand tone: ${brandTone.secondary}`);
  }
  if (brandTone.description) {
    parts.push(`description: ${brandTone.description}`);
  }

  // e5モデル用にpassage:プレフィックスを付与
  return `passage: brand tone design. ${parts.join('. ')}.`;
}

/**
 * 入力バリデーション（Mood）
 */
function validateMoodInput(mood: MoodTextRepresentation | null | undefined): void {
  if (mood === null || mood === undefined) {
    throw new Error('Invalid input: mood cannot be null or undefined');
  }

  if (typeof mood !== 'object') {
    throw new Error('Invalid input: mood must be an object');
  }

  if (typeof mood.primary !== 'string') {
    throw new Error('Invalid input: mood.primary must be a string');
  }

  if (typeof mood.secondary !== 'string') {
    throw new Error('Invalid input: mood.secondary must be a string');
  }

  if (typeof mood.description !== 'string') {
    throw new Error('Invalid input: mood.description must be a string');
  }

  // 空文字列チェック
  if (mood.primary.trim() === '' && mood.secondary.trim() === '' && mood.description.trim() === '') {
    throw new Error('Invalid input: mood text representation cannot be empty');
  }
}

/**
 * 入力バリデーション（BrandTone）
 */
function validateBrandToneInput(brandTone: BrandToneTextRepresentation | null | undefined): void {
  if (brandTone === null || brandTone === undefined) {
    throw new Error('Invalid input: brandTone cannot be null or undefined');
  }

  if (typeof brandTone !== 'object') {
    throw new Error('Invalid input: brandTone must be an object');
  }

  if (typeof brandTone.primary !== 'string') {
    throw new Error('Invalid input: brandTone.primary must be a string');
  }

  if (typeof brandTone.secondary !== 'string') {
    throw new Error('Invalid input: brandTone.secondary must be a string');
  }

  if (typeof brandTone.description !== 'string') {
    throw new Error('Invalid input: brandTone.description must be a string');
  }

  // 空文字列チェック
  if (brandTone.primary.trim() === '' && brandTone.secondary.trim() === '' && brandTone.description.trim() === '') {
    throw new Error('Invalid input: brandTone text representation cannot be empty');
  }
}

/**
 * Embeddingの検証
 * - 768次元であること
 * - L2正規化されていること（ノルム ≈ 1.0）
 */
function validateEmbedding(embedding: number[]): void {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('Invalid embedding: must be a non-empty array');
  }

  if (embedding.length !== DEFAULT_EMBEDDING_DIMENSIONS) {
    throw new Error(`Invalid embedding: expected ${DEFAULT_EMBEDDING_DIMENSIONS} dimensions, got ${embedding.length}`);
  }

  // L2ノルムを計算
  const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));

  // L2正規化のチェック（誤差許容）
  if (Math.abs(norm - 1.0) > 0.01) {
    throw new Error(`Invalid embedding: not L2 normalized (norm = ${norm.toFixed(5)}, expected ≈ 1.0)`);
  }
}

/**
 * L2正規化
 */
function normalizeL2(embedding: number[]): number[] {
  const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
  if (norm === 0) {
    return embedding;
  }
  return embedding.map((val) => val / norm);
}

/**
 * タイムアウト付きPromise実行
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string = 'Operation timed out'
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    }),
  ]);
}

// =====================================================
// バッチ処理ヘルパー関数（複雑度削減用）
// =====================================================

/**
 * バリデーション済みアイテムの型
 */
interface ValidatedItem<T> {
  index: number;
  input: T;
  text: string;
}

/**
 * バッチ処理の共通パラメータ型
 */
interface BatchProcessParams<T> {
  items: T[];
  validateFn: (item: T) => void;
  toTextFn: (item: T) => string;
  type: 'mood' | 'brandTone';
  continueOnError: boolean;
}

/**
 * 入力アイテムをバリデートしてテキスト表現に変換
 */
function validateAndConvertItems<T>(
  params: BatchProcessParams<T>
): ValidatedItem<T>[] {
  const validItems: ValidatedItem<T>[] = [];

  for (let i = 0; i < params.items.length; i++) {
    const item = params.items[i];
    if (!item) continue;

    try {
      params.validateFn(item);
      validItems.push({
        index: i,
        input: item,
        text: params.toTextFn(item),
      });
    } catch {
      if (!params.continueOnError) {
        throw new Error(`Validation error at index ${i}`);
      }
    }
  }

  return validItems;
}

/**
 * Embedding結果を処理してMoodBrandToneEmbeddingResultに変換
 */
function processEmbeddingResult<T>(
  validItem: ValidatedItem<T>,
  rawEmbedding: number[],
  normalize: boolean,
  modelName: string,
  type: 'mood' | 'brandTone',
  continueOnError: boolean
): MoodBrandToneEmbeddingResult | null {
  try {
    const embedding = normalize ? normalizeL2(rawEmbedding) : rawEmbedding;
    validateEmbedding(embedding);

    return {
      embedding,
      textRepresentation: validItem.text,
      modelName,
      processingTimeMs: 0,
      type,
    };
  } catch {
    if (!continueOnError) {
      throw new Error(`Embedding validation error at index ${validItem.index}`);
    }
    return null;
  }
}

// =====================================================
// MoodBrandToneEmbeddingService
// =====================================================

/**
 * デフォルトオプション定数
 */
const DEFAULT_OPTIONS: Required<MoodBrandToneEmbeddingOptions> = {
  modelName: DEFAULT_MODEL_NAME,
  dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
  normalize: true,
  cacheEnabled: true,
  timeout: DEFAULT_TIMEOUT_MS,
};

/**
 * デフォルトオプションを構築（複雑度削減用）
 */
function buildDefaultOptions(options?: MoodBrandToneEmbeddingOptions): Required<MoodBrandToneEmbeddingOptions> {
  if (!options) return { ...DEFAULT_OPTIONS };
  return {
    modelName: options.modelName ?? DEFAULT_OPTIONS.modelName,
    dimensions: options.dimensions ?? DEFAULT_OPTIONS.dimensions,
    normalize: options.normalize ?? DEFAULT_OPTIONS.normalize,
    cacheEnabled: options.cacheEnabled ?? DEFAULT_OPTIONS.cacheEnabled,
    timeout: options.timeout ?? DEFAULT_OPTIONS.timeout,
  };
}

/**
 * Mood/BrandTone Embedding 生成サービス
 */
export class MoodBrandToneEmbeddingService {
  private readonly options: Required<MoodBrandToneEmbeddingOptions>;
  private embeddingService: IEmbeddingService | null = null;

  constructor(options?: MoodBrandToneEmbeddingOptions) {
    this.options = buildDefaultOptions(options);

    if (isDevelopment()) {
      logger.info('[MoodBrandToneEmbedding] Service created', {
        modelName: this.options.modelName,
        dimensions: this.options.dimensions,
        cacheEnabled: this.options.cacheEnabled,
        timeout: this.options.timeout,
      });
    }
  }

  /**
   * EmbeddingServiceを取得（遅延初期化）
   */
  private getEmbeddingService(): IEmbeddingService {
    if (this.embeddingService) {
      return this.embeddingService;
    }

    // DIファクトリがあればそれを使用
    if (embeddingServiceFactory) {
      this.embeddingService = embeddingServiceFactory();
      return this.embeddingService;
    }

    throw new Error('EmbeddingService not initialized. Use setEmbeddingServiceFactory in production.');
  }

  /**
   * Mood テキスト表現から Embedding を生成
   *
   * @param mood - Mood テキスト表現
   * @returns MoodBrandToneEmbeddingResult
   */
  async generateMoodEmbedding(mood: MoodTextRepresentation): Promise<MoodBrandToneEmbeddingResult> {
    // 入力バリデーション
    validateMoodInput(mood);

    const startTime = Date.now();
    const textRepresentation = moodToText(mood);

    if (isDevelopment()) {
      logger.info('[MoodBrandToneEmbedding] Generating mood embedding', {
        textLength: textRepresentation.length,
        primary: mood.primary,
        secondary: mood.secondary,
      });
    }

    const service = this.getEmbeddingService();

    // タイムアウト付きで実行
    const rawEmbedding = await withTimeout(
      service.generateEmbedding(textRepresentation, 'passage'),
      this.options.timeout,
      'Mood embedding generation timed out'
    );

    // L2正規化
    const embedding = this.options.normalize ? normalizeL2(rawEmbedding) : rawEmbedding;

    // 検証
    validateEmbedding(embedding);

    const processingTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info('[MoodBrandToneEmbedding] Mood embedding generated', {
        dimensions: embedding.length,
        processingTimeMs,
      });
    }

    return {
      embedding,
      textRepresentation,
      modelName: this.options.modelName,
      processingTimeMs,
      type: 'mood',
    };
  }

  /**
   * BrandTone テキスト表現から Embedding を生成
   *
   * @param brandTone - BrandTone テキスト表現
   * @returns MoodBrandToneEmbeddingResult
   */
  async generateBrandToneEmbedding(brandTone: BrandToneTextRepresentation): Promise<MoodBrandToneEmbeddingResult> {
    // 入力バリデーション
    validateBrandToneInput(brandTone);

    const startTime = Date.now();
    const textRepresentation = brandToneToText(brandTone);

    if (isDevelopment()) {
      logger.info('[MoodBrandToneEmbedding] Generating brandTone embedding', {
        textLength: textRepresentation.length,
        primary: brandTone.primary,
        secondary: brandTone.secondary,
      });
    }

    const service = this.getEmbeddingService();

    // タイムアウト付きで実行
    const rawEmbedding = await withTimeout(
      service.generateEmbedding(textRepresentation, 'passage'),
      this.options.timeout,
      'BrandTone embedding generation timed out'
    );

    // L2正規化
    const embedding = this.options.normalize ? normalizeL2(rawEmbedding) : rawEmbedding;

    // 検証
    validateEmbedding(embedding);

    const processingTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info('[MoodBrandToneEmbedding] BrandTone embedding generated', {
        dimensions: embedding.length,
        processingTimeMs,
      });
    }

    return {
      embedding,
      textRepresentation,
      modelName: this.options.modelName,
      processingTimeMs,
      type: 'brandTone',
    };
  }

  /**
   * 複数の Mood テキスト表現から Embedding を一括生成
   *
   * @param moods - Mood テキスト表現配列
   * @param options - バッチオプション
   * @returns MoodBrandToneEmbeddingResult配列
   */
  async generateBatchMoodEmbeddings(
    moods: MoodTextRepresentation[],
    options?: BatchOptions
  ): Promise<MoodBrandToneEmbeddingResult[]> {
    return this.generateBatchEmbeddings(
      moods,
      validateMoodInput,
      moodToText,
      (mood) => this.generateMoodEmbedding(mood),
      'mood',
      options
    );
  }

  /**
   * バッチEmbedding生成の共通ロジック
   */
  private async generateBatchEmbeddings<T>(
    items: T[],
    validateFn: (item: T) => void,
    toTextFn: (item: T) => string,
    generateSingleFn: (item: T) => Promise<MoodBrandToneEmbeddingResult>,
    type: 'mood' | 'brandTone',
    options?: BatchOptions
  ): Promise<MoodBrandToneEmbeddingResult[]> {
    if (items.length === 0) {
      return [];
    }

    const startTime = Date.now();
    const continueOnError = options?.continueOnError ?? true;

    if (isDevelopment()) {
      logger.info(`[MoodBrandToneEmbedding] Starting batch ${type} generation`, {
        count: items.length,
      });
    }

    // アイテムをバリデートしてテキスト表現に変換
    const validItems = validateAndConvertItems({
      items,
      validateFn,
      toTextFn,
      type,
      continueOnError,
    });

    if (validItems.length === 0) {
      return [];
    }

    // バッチ処理を試みる
    const results = await this.processBatchEmbeddings(
      validItems,
      generateSingleFn,
      type,
      continueOnError,
      options
    );

    const totalTime = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info(`[MoodBrandToneEmbedding] Batch ${type} generation completed`, {
        total: items.length,
        successful: results.length,
        totalTimeMs: totalTime,
      });
    }

    return results;
  }

  /**
   * バッチEmbedding処理の実行
   */
  private async processBatchEmbeddings<T>(
    validItems: ValidatedItem<T>[],
    generateSingleFn: (item: T) => Promise<MoodBrandToneEmbeddingResult>,
    type: 'mood' | 'brandTone',
    continueOnError: boolean,
    options?: BatchOptions
  ): Promise<MoodBrandToneEmbeddingResult[]> {
    const results: MoodBrandToneEmbeddingResult[] = [];
    const service = this.getEmbeddingService();
    const texts = validItems.map((v) => v.text);

    try {
      const embeddings = await withTimeout(
        service.generateBatchEmbeddings(texts, 'passage'),
        this.options.timeout,
        `Batch ${type} embedding generation timed out`
      );

      for (let i = 0; i < validItems.length; i++) {
        const validItem = validItems[i];
        const rawEmbedding = embeddings[i];

        if (!validItem || !rawEmbedding) continue;

        const result = processEmbeddingResult(
          validItem,
          rawEmbedding,
          this.options.normalize,
          this.options.modelName,
          type,
          continueOnError
        );

        if (result) {
          results.push(result);
        }

        options?.onProgress?.(i + 1, validItems.length);
      }
    } catch (batchError) {
      // バッチ処理が失敗した場合、個別に処理
      if (isDevelopment()) {
        logger.warn('[MoodBrandToneEmbedding] Batch processing failed, falling back to individual', {
          error: batchError instanceof Error ? batchError.message : 'Unknown error',
        });
      }

      await this.processBatchFallback(validItems, generateSingleFn, continueOnError, options, results);
    }

    return results;
  }

  /**
   * バッチ処理失敗時のフォールバック処理
   */
  private async processBatchFallback<T>(
    validItems: ValidatedItem<T>[],
    generateSingleFn: (item: T) => Promise<MoodBrandToneEmbeddingResult>,
    continueOnError: boolean,
    options: BatchOptions | undefined,
    results: MoodBrandToneEmbeddingResult[]
  ): Promise<void> {
    for (let i = 0; i < validItems.length; i++) {
      const validItem = validItems[i];
      if (!validItem) continue;

      try {
        const result = await generateSingleFn(validItem.input);
        results.push(result);
      } catch {
        if (!continueOnError) {
          throw new Error(`Individual embedding error at index ${validItem.index}`);
        }
      }

      options?.onProgress?.(i + 1, validItems.length);
    }
  }

  /**
   * 複数の BrandTone テキスト表現から Embedding を一括生成
   *
   * @param brandTones - BrandTone テキスト表現配列
   * @param options - バッチオプション
   * @returns MoodBrandToneEmbeddingResult配列
   */
  async generateBatchBrandToneEmbeddings(
    brandTones: BrandToneTextRepresentation[],
    options?: BatchOptions
  ): Promise<MoodBrandToneEmbeddingResult[]> {
    return this.generateBatchEmbeddings(
      brandTones,
      validateBrandToneInput,
      brandToneToText,
      (brandTone) => this.generateBrandToneEmbedding(brandTone),
      'brandTone',
      options
    );
  }

  /**
   * キャッシュ統計を取得
   */
  getCacheStats(): CacheStats {
    try {
      const service = this.getEmbeddingService();
      return service.getCacheStats();
    } catch {
      return { hits: 0, misses: 0, size: 0, evictions: 0 };
    }
  }

  /**
   * キャッシュをクリア
   */
  clearCache(): void {
    try {
      const service = this.getEmbeddingService();
      service.clearCache();
    } catch {
      // サービスが初期化されていない場合は何もしない
    }
  }
}

// =====================================================
// DB保存関数
// =====================================================

/**
 * Upsert用のデータを構築するヘルパー関数
 */
interface UpsertData {
  create: {
    sectionPatternId: string;
    modelVersion: string;
    textRepresentation?: string;
    moodTextRepresentation?: string;
    brandToneTextRepresentation?: string;
  };
  update: {
    moodTextRepresentation?: string;
    brandToneTextRepresentation?: string;
    modelVersion?: string;
  };
}

function buildUpsertData(
  sectionPatternId: string,
  data: { mood?: MoodBrandToneEmbeddingResult; brandTone?: MoodBrandToneEmbeddingResult }
): UpsertData {
  const modelVersion = data.mood?.modelName ?? data.brandTone?.modelName ?? DEFAULT_MODEL_NAME;
  const createData: UpsertData['create'] = { sectionPatternId, modelVersion };
  const updateData: UpsertData['update'] = { modelVersion };

  if (data.mood) {
    createData.moodTextRepresentation = data.mood.textRepresentation;
    updateData.moodTextRepresentation = data.mood.textRepresentation;
  }
  if (data.brandTone) {
    createData.brandToneTextRepresentation = data.brandTone.textRepresentation;
    updateData.brandToneTextRepresentation = data.brandTone.textRepresentation;
  }

  return { create: createData, update: updateData };
}

/**
 * pgvector形式でEmbeddingを更新するヘルパー関数
 */
async function updateVectorEmbeddings(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  sectionEmbeddingId: string,
  data: { mood?: MoodBrandToneEmbeddingResult; brandTone?: MoodBrandToneEmbeddingResult }
): Promise<void> {
  if (data.mood) {
    const moodVectorString = `[${data.mood.embedding.join(',')}]`;
    await tx.$executeRawUnsafe(
      `UPDATE section_embeddings SET mood_embedding = $1::vector WHERE id = $2::uuid`,
      moodVectorString,
      sectionEmbeddingId
    );
  }
  if (data.brandTone) {
    const brandToneVectorString = `[${data.brandTone.embedding.join(',')}]`;
    await tx.$executeRawUnsafe(
      `UPDATE section_embeddings SET brand_tone_embedding = $1::vector WHERE id = $2::uuid`,
      brandToneVectorString,
      sectionEmbeddingId
    );
  }
}

/**
 * Mood/BrandTone Embedding を SectionEmbedding に保存（upsert パターン）
 *
 * 既存のSectionEmbeddingがある場合は更新、なければ新規作成します。
 *
 * @param sectionPatternId - SectionPattern ID
 * @param data - 保存するデータ（mood, brandTone のいずれかまたは両方）
 * @returns 作成/更新されたSectionEmbedding
 */
export async function saveMoodBrandToneEmbedding(
  sectionPatternId: string,
  data: {
    mood?: MoodBrandToneEmbeddingResult;
    brandTone?: MoodBrandToneEmbeddingResult;
  }
): Promise<SectionEmbeddingData> {
  const prisma = getPrismaClient();

  // 入力バリデーション
  if (!sectionPatternId || typeof sectionPatternId !== 'string') {
    throw new Error('Invalid sectionPatternId: must be a non-empty string');
  }

  if (!data.mood && !data.brandTone) {
    throw new Error('At least one of mood or brandTone must be provided');
  }

  // Embedding の検証
  if (data.mood) validateEmbedding(data.mood.embedding);
  if (data.brandTone) validateEmbedding(data.brandTone.embedding);

  if (isDevelopment()) {
    logger.info('[MoodBrandToneEmbedding] Saving mood/brandTone embedding', {
      sectionPatternId,
      hasMood: !!data.mood,
      hasBrandTone: !!data.brandTone,
    });
  }

  // トランザクション内で実行
  return prisma.$transaction(async (tx) => {
    const { create: createData, update: updateData } = buildUpsertData(sectionPatternId, data);

    // Upsert パターン: 既存があれば更新、なければ作成
    const sectionEmbedding = await tx.sectionEmbedding.upsert({
      where: { sectionPatternId },
      create: createData,
      update: updateData,
    });

    // pgvector形式でEmbeddingを更新（Raw SQL必須）
    await updateVectorEmbeddings(tx, sectionEmbedding.id, data);

    if (isDevelopment()) {
      logger.info('[MoodBrandToneEmbedding] Saved mood/brandTone embedding', {
        sectionEmbeddingId: sectionEmbedding.id,
        sectionPatternId,
      });
    }

    return sectionEmbedding;
  });
}

/**
 * バッチで Mood/BrandTone Embedding を SectionEmbedding に保存（upsert パターン）
 *
 * トランザクション内で全ての操作を実行し、エラー時は自動的にロールバックします。
 *
 * @param sectionPatternIds - SectionPattern ID配列
 * @param results - 保存するデータ配列
 * @returns 作成/更新されたSectionEmbedding配列
 * @throws 配列の長さが一致しない場合、またはDB操作に失敗した場合
 */
export async function saveBatchMoodBrandToneEmbeddings(
  sectionPatternIds: string[],
  results: Array<{
    mood?: MoodBrandToneEmbeddingResult;
    brandTone?: MoodBrandToneEmbeddingResult;
  }>
): Promise<SectionEmbeddingData[]> {
  // 入力バリデーション
  if (sectionPatternIds.length !== results.length) {
    throw new Error('sectionPatternIds and results must have the same length');
  }

  if (sectionPatternIds.length === 0) {
    return [];
  }

  // 各アイテムの事前バリデーション
  validateBatchSaveInputs(sectionPatternIds, results);

  const prisma = getPrismaClient();
  const startTime = Date.now();

  if (isDevelopment()) {
    logger.info('[MoodBrandToneEmbedding] Starting batch save', {
      count: sectionPatternIds.length,
    });
  }

  // トランザクション内で実行（エラー時は自動ロールバック）
  return prisma.$transaction(async (tx) => {
    const savedResults: SectionEmbeddingData[] = [];

    for (let i = 0; i < sectionPatternIds.length; i++) {
      const sectionPatternId = sectionPatternIds[i];
      const data = results[i];

      if (!sectionPatternId || !data) continue;
      if (!data.mood && !data.brandTone) continue;

      const { create: createData, update: updateData } = buildUpsertData(sectionPatternId, data);

      const sectionEmbedding = await tx.sectionEmbedding.upsert({
        where: { sectionPatternId },
        create: createData,
        update: updateData,
      });

      await updateVectorEmbeddings(tx, sectionEmbedding.id, data);
      savedResults.push(sectionEmbedding);
    }

    const duration = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info('[MoodBrandToneEmbedding] Batch save completed', {
        count: savedResults.length,
        durationMs: duration,
      });
    }

    return savedResults;
  });
}

/**
 * バッチ保存の入力バリデーションヘルパー
 */
function validateBatchSaveInputs(
  sectionPatternIds: string[],
  results: Array<{
    mood?: MoodBrandToneEmbeddingResult;
    brandTone?: MoodBrandToneEmbeddingResult;
  }>
): void {
  for (let i = 0; i < sectionPatternIds.length; i++) {
    const sectionPatternId = sectionPatternIds[i];
    const data = results[i];

    if (!sectionPatternId || typeof sectionPatternId !== 'string') {
      throw new Error(`Invalid sectionPatternId at index ${i}: must be a non-empty string`);
    }

    if (data?.mood) validateEmbedding(data.mood.embedding);
    if (data?.brandTone) validateEmbedding(data.brandTone.embedding);
  }
}

// =====================================================
// デフォルトエクスポート
// =====================================================

export default MoodBrandToneEmbeddingService;
