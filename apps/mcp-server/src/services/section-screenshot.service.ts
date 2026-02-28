// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SectionScreenshotService
 *
 * フルページスクリーンショットからセクションを切り出すサービス
 *
 * 機能:
 * - Sharpを使用したセクション画像の切り出し
 * - Base64またはBufferの入力に対応
 * - 複数セクションの並列切り出し対応
 * - 境界外アクセスのエラーハンドリング
 *
 * @module @reftrix/mcp-server/services/section-screenshot.service
 */

import sharp from 'sharp';
import { createLogger, type ILogger } from '../utils/logger';

// ============================================================================
// 型定義
// ============================================================================

/**
 * セクションの境界情報
 */
export interface SectionBounds {
  /** セクション開始Y座標（ピクセル） */
  startY: number;
  /** セクション終了Y座標（ピクセル） */
  endY: number;
  /** セクションの高さ（ピクセル） */
  height: number;
}

/**
 * セクションスクリーンショット切り出し結果
 */
export interface SectionScreenshotResult {
  /** セクションID */
  sectionId: string;
  /** 切り出した画像のBuffer */
  imageBuffer: Buffer;
  /** Base64エンコードされた画像データ */
  base64: string;
  /** セクションの境界情報 */
  bounds: SectionBounds;
  /** 画像の幅（ピクセル） */
  width: number;
  /** 画像の高さ（ピクセル） */
  height: number;
}

/**
 * セクション切り出しエラー情報
 */
export interface SectionScreenshotError {
  /** セクションID */
  sectionId: string;
  /** エラーコード */
  errorCode: SectionScreenshotErrorCode;
  /** エラーメッセージ */
  errorMessage: string;
  /** 追加情報 */
  details?: Record<string, unknown> | undefined;
}

/**
 * 複数セクション切り出し結果
 */
export interface MultiSectionResult {
  /** 成功した切り出し結果 */
  successes: SectionScreenshotResult[];
  /** 失敗したセクションのエラー情報 */
  errors: SectionScreenshotError[];
}

/**
 * セクション切り出しオプション
 */
export interface SectionScreenshotOptions {
  /** 出力フォーマット（デフォルト: png） */
  format?: 'png' | 'jpeg' | 'webp';
  /** JPEG/WebP品質（1-100、デフォルト: 90） */
  quality?: number;
  /** 並列処理の最大同時実行数（デフォルト: 5） */
  maxConcurrency?: number;
}

/**
 * エラーコード
 */
export type SectionScreenshotErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_BOUNDS'
  | 'OUT_OF_BOUNDS'
  | 'EXTRACTION_FAILED'
  | 'IMAGE_PROCESSING_ERROR';

// ============================================================================
// エラークラス
// ============================================================================

/**
 * セクションスクリーンショットサービスエラー
 */
export class SectionScreenshotServiceError extends Error {
  public readonly code: SectionScreenshotErrorCode;
  public readonly details: Record<string, unknown> | undefined;

  constructor(
    code: SectionScreenshotErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'SectionScreenshotServiceError';
    this.code = code;
    this.details = details;
  }
}

// ============================================================================
// デフォルト設定
// ============================================================================

const DEFAULT_OPTIONS: Required<SectionScreenshotOptions> = {
  format: 'png',
  quality: 90,
  maxConcurrency: 5,
};

// ============================================================================
// SectionScreenshotService クラス
// ============================================================================

/**
 * フルページスクリーンショットからセクションを切り出すサービス
 *
 * @example
 * ```typescript
 * const service = new SectionScreenshotService();
 *
 * // 単一セクション切り出し
 * const result = await service.extractSection(
 *   fullPageBase64,
 *   { startY: 0, endY: 800, height: 800 },
 *   'hero-section'
 * );
 *
 * // 複数セクション並列切り出し
 * const results = await service.extractMultipleSections(
 *   fullPageBase64,
 *   [
 *     { id: 'hero', bounds: { startY: 0, endY: 800, height: 800 } },
 *     { id: 'features', bounds: { startY: 800, endY: 1600, height: 800 } },
 *   ]
 * );
 * ```
 */
export class SectionScreenshotService {
  private readonly logger: ILogger;
  private readonly options: Required<SectionScreenshotOptions>;

  /**
   * コンストラクタ
   * @param options - サービスオプション
   */
  constructor(options: SectionScreenshotOptions = {}) {
    this.logger = createLogger('SectionScreenshot');
    this.options = {
      format: options.format ?? DEFAULT_OPTIONS.format,
      quality: options.quality ?? DEFAULT_OPTIONS.quality,
      maxConcurrency: options.maxConcurrency ?? DEFAULT_OPTIONS.maxConcurrency,
    };

    this.logger.debug('Service initialized', {
      format: this.options.format,
      quality: this.options.quality,
      maxConcurrency: this.options.maxConcurrency,
    });
  }

  // ==========================================================================
  // パブリックメソッド
  // ==========================================================================

  /**
   * 単一セクションを切り出す
   *
   * @param fullPageBase64 - フルページスクリーンショットのBase64文字列
   * @param bounds - セクションの境界情報
   * @param sectionId - セクション識別子
   * @param options - 切り出しオプション（オプション）
   * @returns セクション切り出し結果
   * @throws SectionScreenshotServiceError
   */
  async extractSection(
    fullPageBase64: string,
    bounds: SectionBounds,
    sectionId: string,
    options?: SectionScreenshotOptions
  ): Promise<SectionScreenshotResult> {
    this.logger.debug('extractSection called', {
      sectionId,
      bounds,
    });

    // 入力バリデーション
    this.validateInput(fullPageBase64, sectionId);
    this.validateBounds(bounds, sectionId);

    // Base64をBufferに変換
    const imageBuffer = this.base64ToBuffer(fullPageBase64);

    // 画像メタデータを取得
    const metadata = await this.getImageMetadata(imageBuffer, sectionId);

    // 境界チェック
    this.validateBoundsAgainstImage(bounds, metadata.height, sectionId);

    // セクションを切り出し
    const result = await this.extractFromBuffer(
      imageBuffer,
      bounds,
      sectionId,
      metadata.width,
      options
    );

    this.logger.debug('extractSection completed', {
      sectionId,
      width: result.width,
      height: result.height,
      bufferSize: result.imageBuffer.length,
    });

    return result;
  }

  /**
   * 複数セクションを並列で切り出す
   *
   * @param fullPageBase64 - フルページスクリーンショットのBase64文字列
   * @param sections - セクション情報の配列
   * @param options - 切り出しオプション（オプション）
   * @returns 成功結果とエラー情報を含む結果オブジェクト
   */
  async extractMultipleSections(
    fullPageBase64: string,
    sections: Array<{ id: string; bounds: SectionBounds }>,
    options?: SectionScreenshotOptions
  ): Promise<MultiSectionResult> {
    this.logger.debug('extractMultipleSections called', {
      sectionCount: sections.length,
    });

    if (sections.length === 0) {
      return { successes: [], errors: [] };
    }

    // 入力バリデーション
    this.validateInput(fullPageBase64, 'batch');

    // Base64をBufferに変換（一度だけ）
    const imageBuffer = this.base64ToBuffer(fullPageBase64);

    // 画像メタデータを取得（一度だけ）
    const metadata = await this.getImageMetadata(imageBuffer, 'batch');

    // 並列処理の実行
    const results = await this.processInBatches(
      sections,
      imageBuffer,
      metadata,
      options
    );

    this.logger.debug('extractMultipleSections completed', {
      successCount: results.successes.length,
      errorCount: results.errors.length,
    });

    return results;
  }

  // ==========================================================================
  // プライベートメソッド - バリデーション
  // ==========================================================================

  /**
   * 入力のバリデーション
   */
  private validateInput(fullPageBase64: string, sectionId: string): void {
    if (!fullPageBase64 || typeof fullPageBase64 !== 'string') {
      throw new SectionScreenshotServiceError(
        'INVALID_INPUT',
        'fullPageBase64 must be a non-empty string',
        { sectionId }
      );
    }

    // Base64の基本形式チェック
    // data:image/... プレフィックスがある場合は除去
    const base64Data = fullPageBase64.includes(',')
      ? fullPageBase64.split(',')[1]
      : fullPageBase64;

    if (!base64Data || base64Data.length === 0) {
      throw new SectionScreenshotServiceError(
        'INVALID_INPUT',
        'Invalid Base64 data: empty after removing prefix',
        { sectionId }
      );
    }
  }

  /**
   * 境界情報のバリデーション
   */
  private validateBounds(bounds: SectionBounds, sectionId: string): void {
    if (bounds.startY < 0) {
      throw new SectionScreenshotServiceError(
        'INVALID_BOUNDS',
        `startY must be >= 0, got ${bounds.startY}`,
        { sectionId, bounds }
      );
    }

    if (bounds.endY <= bounds.startY) {
      throw new SectionScreenshotServiceError(
        'INVALID_BOUNDS',
        `endY (${bounds.endY}) must be greater than startY (${bounds.startY})`,
        { sectionId, bounds }
      );
    }

    if (bounds.height <= 0) {
      throw new SectionScreenshotServiceError(
        'INVALID_BOUNDS',
        `height must be > 0, got ${bounds.height}`,
        { sectionId, bounds }
      );
    }

    // height と startY/endY の整合性チェック
    const calculatedHeight = bounds.endY - bounds.startY;
    if (Math.abs(calculatedHeight - bounds.height) > 1) {
      // 1ピクセルの許容誤差
      this.logger.warn('Height mismatch detected, using calculated height', {
        sectionId,
        providedHeight: bounds.height,
        calculatedHeight,
      });
    }
  }

  /**
   * 境界が画像サイズ内に収まっているか確認
   */
  private validateBoundsAgainstImage(
    bounds: SectionBounds,
    imageHeight: number,
    sectionId: string
  ): void {
    if (bounds.startY >= imageHeight) {
      throw new SectionScreenshotServiceError(
        'OUT_OF_BOUNDS',
        `startY (${bounds.startY}) is outside image height (${imageHeight})`,
        { sectionId, bounds, imageHeight }
      );
    }

    if (bounds.endY > imageHeight) {
      throw new SectionScreenshotServiceError(
        'OUT_OF_BOUNDS',
        `endY (${bounds.endY}) exceeds image height (${imageHeight})`,
        { sectionId, bounds, imageHeight }
      );
    }
  }

  // ==========================================================================
  // プライベートメソッド - 画像処理
  // ==========================================================================

  /**
   * Base64をBufferに変換
   */
  private base64ToBuffer(base64String: string): Buffer {
    // data:image/... プレフィックスがある場合は除去
    const base64Data = base64String.includes(',')
      ? base64String.split(',')[1]
      : base64String;

    try {
      return Buffer.from(base64Data!, 'base64');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new SectionScreenshotServiceError(
        'INVALID_INPUT',
        `Failed to decode Base64: ${message}`,
        { originalError: message }
      );
    }
  }

  /**
   * 画像メタデータを取得
   */
  private async getImageMetadata(
    buffer: Buffer,
    sectionId: string
  ): Promise<{ width: number; height: number }> {
    try {
      const metadata = await sharp(buffer).metadata();

      if (!metadata.width || !metadata.height) {
        throw new SectionScreenshotServiceError(
          'IMAGE_PROCESSING_ERROR',
          'Could not determine image dimensions',
          { sectionId }
        );
      }

      return {
        width: metadata.width,
        height: metadata.height,
      };
    } catch (error) {
      if (error instanceof SectionScreenshotServiceError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new SectionScreenshotServiceError(
        'IMAGE_PROCESSING_ERROR',
        `Failed to read image metadata: ${message}`,
        { sectionId, originalError: message }
      );
    }
  }

  /**
   * Bufferからセクションを切り出し
   */
  private async extractFromBuffer(
    buffer: Buffer,
    bounds: SectionBounds,
    sectionId: string,
    imageWidth: number,
    options?: SectionScreenshotOptions
  ): Promise<SectionScreenshotResult> {
    const format = options?.format ?? this.options.format;
    const quality = options?.quality ?? this.options.quality;

    // 実際の切り出し高さを計算（endY - startY を使用）
    const extractHeight = bounds.endY - bounds.startY;

    try {
      // Sharpで切り出し
      let sharpInstance = sharp(buffer).extract({
        left: 0,
        top: bounds.startY,
        width: imageWidth,
        height: extractHeight,
      });

      // フォーマット変換
      switch (format) {
        case 'jpeg':
          sharpInstance = sharpInstance.jpeg({ quality });
          break;
        case 'webp':
          sharpInstance = sharpInstance.webp({ quality });
          break;
        case 'png':
        default:
          sharpInstance = sharpInstance.png();
          break;
      }

      const outputBuffer = await sharpInstance.toBuffer();
      const base64Output = outputBuffer.toString('base64');

      // data URIプレフィックスを付与
      const mimeType =
        format === 'jpeg'
          ? 'image/jpeg'
          : format === 'webp'
            ? 'image/webp'
            : 'image/png';
      const base64WithPrefix = `data:${mimeType};base64,${base64Output}`;

      return {
        sectionId,
        imageBuffer: outputBuffer,
        base64: base64WithPrefix,
        bounds,
        width: imageWidth,
        height: extractHeight,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new SectionScreenshotServiceError(
        'EXTRACTION_FAILED',
        `Failed to extract section: ${message}`,
        { sectionId, bounds, originalError: message }
      );
    }
  }

  /**
   * バッチ処理で複数セクションを並列処理
   */
  private async processInBatches(
    sections: Array<{ id: string; bounds: SectionBounds }>,
    imageBuffer: Buffer,
    metadata: { width: number; height: number },
    options?: SectionScreenshotOptions
  ): Promise<MultiSectionResult> {
    const successes: SectionScreenshotResult[] = [];
    const errors: SectionScreenshotError[] = [];

    const maxConcurrency =
      options?.maxConcurrency ?? this.options.maxConcurrency;

    // バッチに分割して処理
    for (let i = 0; i < sections.length; i += maxConcurrency) {
      const batch = sections.slice(i, i + maxConcurrency);

      const batchPromises = batch.map(async (section) => {
        try {
          // 境界バリデーション
          this.validateBounds(section.bounds, section.id);
          this.validateBoundsAgainstImage(
            section.bounds,
            metadata.height,
            section.id
          );

          // 切り出し
          const result = await this.extractFromBuffer(
            imageBuffer,
            section.bounds,
            section.id,
            metadata.width,
            options
          );

          return { success: true as const, result };
        } catch (error) {
          const errorInfo = this.createErrorInfo(section.id, error);
          return { success: false as const, error: errorInfo };
        }
      });

      const batchResults = await Promise.all(batchPromises);

      for (const result of batchResults) {
        if (result.success) {
          successes.push(result.result);
        } else {
          errors.push(result.error);
        }
      }
    }

    return { successes, errors };
  }

  /**
   * エラー情報を作成
   */
  private createErrorInfo(
    sectionId: string,
    error: unknown
  ): SectionScreenshotError {
    if (error instanceof SectionScreenshotServiceError) {
      return {
        sectionId,
        errorCode: error.code,
        errorMessage: error.message,
        details: error.details,
      };
    }

    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      sectionId,
      errorCode: 'EXTRACTION_FAILED',
      errorMessage: message,
      details: { originalError: message },
    };
  }
}

// ============================================================================
// エクスポート
// ============================================================================

export default SectionScreenshotService;
