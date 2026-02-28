// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Frame Loader
 *
 * Sharp を使用したフレーム画像読み込みモジュール
 * セキュリティ要件:
 * - パストラバーサル防止（../ 検出）
 * - 許可ディレクトリ外アクセス拒否
 * - ファイルサイズ上限チェック（10MB）
 *
 * @module @reftrix/mcp-server/services/motion/infrastructure/frame-loader
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import sharp from 'sharp';
import {
  FrameLoaderError,
  type FrameLoaderData,
  type FrameLoaderMetadata,
  type FrameLoaderOptions,
  type FramePair,
  type PathValidationResult,
  LIMITS,
} from '../types';

// ============================================================================
// 定数
// ============================================================================

/** デフォルトファイルサイズ上限（10MB） */
const DEFAULT_MAX_FILE_SIZE = LIMITS.MAX_FILE_SIZE;

/** 許可された拡張子 */
const ALLOWED_EXTENSIONS = LIMITS.ALLOWED_EXTENSIONS;

// ============================================================================
// FrameLoader クラス
// ============================================================================

/**
 * フレーム画像読み込みクラス
 *
 * @example
 * ```typescript
 * const loader = new FrameLoader({
 *   allowedDirectories: ['/path/to/frames'],
 *   maxFileSize: 10 * 1024 * 1024,
 * });
 *
 * const frameData = await loader.loadFrame('/path/to/frames/frame_001.png');
 * console.log(frameData.metadata.width, frameData.metadata.height);
 * ```
 */
export class FrameLoader {
  private readonly allowedDirectories: string[];
  private readonly maxFileSize: number;
  private readonly optimizeMemory: boolean;
  private readonly maxWidth?: number;
  private readonly maxHeight?: number;

  /**
   * コンストラクタ
   * @param options - ローダーオプション
   */
  constructor(options: FrameLoaderOptions = {}) {
    this.allowedDirectories = options.allowedDirectories ?? [process.cwd()];
    this.maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.optimizeMemory = options.optimizeMemory ?? false;
    // undefined のままで保持（exactOptionalPropertyTypes対応）
    if (options.maxWidth !== undefined) {
      this.maxWidth = options.maxWidth;
    }
    if (options.maxHeight !== undefined) {
      this.maxHeight = options.maxHeight;
    }

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[FrameLoader] Initialized with options:', {
        allowedDirectories: this.allowedDirectories,
        maxFileSize: this.maxFileSize,
        optimizeMemory: this.optimizeMemory,
        maxWidth: this.maxWidth,
        maxHeight: this.maxHeight,
      });
    }
  }

  // ==========================================================================
  // パス検証
  // ==========================================================================

  /**
   * パストラバーサルパターンを検出
   * @param filePath - チェックするパス
   * @returns トラバーサルパターンが見つかった場合 true
   */
  private detectPathTraversal(filePath: string): boolean {
    // URLデコードして検出を回避する試みを防ぐ
    const decodedPath = decodeURIComponent(filePath);

    // パストラバーサルパターン
    const traversalPatterns = [
      '..', // 親ディレクトリ参照
      '%2e%2e', // URLエンコードされた ..
      '%2E%2E', // 大文字版
      '..\\', // Windows形式
      '../', // Unix形式
    ];

    for (const pattern of traversalPatterns) {
      if (decodedPath.includes(pattern) || filePath.includes(pattern)) {
        return true;
      }
    }

    // 正規化後のパスが元のパスと同じディレクトリ構造を持つか確認
    const normalized = path.normalize(filePath);
    if (normalized.includes('..')) {
      return true;
    }

    // 正規化前後でパスが変わる場合はトラバーサルの可能性
    // path.resolve後に許可ディレクトリのどれかのサブディレクトリでなくなる場合
    const resolved = path.resolve(filePath);
    for (const allowedDir of this.allowedDirectories) {
      const normalizedAllowedDir = path.resolve(allowedDir);
      // 許可ディレクトリ配下かつ、正規化前のパスに許可ディレクトリのパスが含まれている場合
      // （つまり、元のパスが許可ディレクトリから始まっていたが、正規化後に外に出た場合）
      if (filePath.includes(allowedDir) && !resolved.startsWith(normalizedAllowedDir)) {
        return true;
      }
    }

    return false;
  }

  /**
   * パスが許可ディレクトリ内にあるか確認
   * @param filePath - チェックするパス
   * @returns 許可ディレクトリ内の場合 true
   */
  private isWithinAllowedDirectories(filePath: string): boolean {
    const normalizedPath = path.resolve(filePath);

    for (const allowedDir of this.allowedDirectories) {
      const normalizedAllowedDir = path.resolve(allowedDir);
      if (normalizedPath.startsWith(normalizedAllowedDir + path.sep)) {
        return true;
      }
      // ファイルが許可ディレクトリ直下の場合もOK
      if (path.dirname(normalizedPath) === normalizedAllowedDir) {
        return true;
      }
    }

    return false;
  }

  /**
   * ファイル拡張子を検証
   * @param filePath - チェックするパス
   * @returns 有効な拡張子の場合 true
   */
  private hasValidExtension(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ALLOWED_EXTENSIONS.includes(ext);
  }

  /**
   * フレームパスを検証
   * @param filePath - 検証するファイルパス
   * @returns 検証結果
   */
  async validateFramePath(filePath: string): Promise<PathValidationResult> {
    // 1. パストラバーサル検出
    if (this.detectPathTraversal(filePath)) {
      return {
        isValid: false,
        errorCode: 'PATH_TRAVERSAL',
        errorMessage: 'Path traversal detected: access denied',
      };
    }

    // 2. 許可ディレクトリ検証
    if (!this.isWithinAllowedDirectories(filePath)) {
      return {
        isValid: false,
        errorCode: 'OUTSIDE_ALLOWED_DIR',
        errorMessage: 'File is outside allowed directories',
      };
    }

    // 3. 拡張子検証
    if (!this.hasValidExtension(filePath)) {
      return {
        isValid: false,
        errorCode: 'INVALID_EXTENSION',
        errorMessage: `Invalid file extension. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`,
      };
    }

    // 4. ファイル存在確認
    try {
      const stats = await fs.promises.stat(filePath);

      // ファイルかどうか確認
      if (!stats.isFile()) {
        return {
          isValid: false,
          errorCode: 'NOT_A_FILE',
          errorMessage: 'Path is not a file',
        };
      }

      // 5. ファイルサイズ検証
      if (stats.size > this.maxFileSize) {
        return {
          isValid: false,
          errorCode: 'FILE_TOO_LARGE',
          errorMessage: `File size (${stats.size} bytes) exceeds limit (${this.maxFileSize} bytes)`,
        };
      }
    } catch (error: unknown) {
      const errno = error as { code?: string };
      if (errno.code === 'ENOENT') {
        return {
          isValid: false,
          errorCode: 'FILE_NOT_FOUND',
          errorMessage: 'File not found',
        };
      }
      if (errno.code === 'EACCES') {
        return {
          isValid: false,
          errorCode: 'PERMISSION_DENIED',
          errorMessage: 'Permission denied',
        };
      }
      throw error;
    }

    return {
      isValid: true,
      normalizedPath: path.resolve(filePath),
    };
  }

  // ==========================================================================
  // メタデータ取得
  // ==========================================================================

  /**
   * フレーム画像のメタデータを取得
   * @param filePath - 画像ファイルパス
   * @returns メタデータ
   * @throws FrameLoaderError パスが無効な場合
   */
  async getFrameMetadata(filePath: string): Promise<FrameLoaderMetadata> {
    // パス検証
    const validation = await this.validateFramePath(filePath);
    if (!validation.isValid) {
      throw new FrameLoaderError(
        validation.errorCode!,
        validation.errorMessage!
      );
    }

    try {
      // ファイルサイズを取得
      const stats = await fs.promises.stat(filePath);

      // Sharp でメタデータを取得
      const sharpMetadata = await sharp(filePath).metadata();

      // フォーマットを判定
      let format: 'png' | 'jpeg';
      if (sharpMetadata.format === 'png') {
        format = 'png';
      } else if (sharpMetadata.format === 'jpeg') {
        format = 'jpeg';
      } else {
        throw new FrameLoaderError(
          'INVALID_EXTENSION',
          `Unsupported format: ${sharpMetadata.format}`
        );
      }

      // チャンネル数を判定（PNG は通常4、JPEG は3）
      const channels = (sharpMetadata.channels ?? 4) as 3 | 4;

      return {
        path: filePath,
        width: sharpMetadata.width!,
        height: sharpMetadata.height!,
        channels,
        fileSize: stats.size,
        format,
      };
    } catch (error) {
      if (error instanceof FrameLoaderError) {
        throw error;
      }
      throw new FrameLoaderError('LOAD_FAILED', `Failed to read metadata: ${error}`, {
        originalError: String(error),
      });
    }
  }

  // ==========================================================================
  // フレーム読み込み
  // ==========================================================================

  /**
   * 単一フレームを読み込み
   * @param filePath - 画像ファイルパス
   * @returns フレームデータ（メタデータ + RGBAバッファ）
   * @throws FrameLoaderError パスが無効またはロード失敗
   */
  async loadFrame(filePath: string): Promise<FrameLoaderData> {
    // パス検証
    const validation = await this.validateFramePath(filePath);
    if (!validation.isValid) {
      throw new FrameLoaderError(
        validation.errorCode!,
        validation.errorMessage!
      );
    }

    try {
      // ファイルサイズを取得
      const stats = await fs.promises.stat(filePath);

      // Sharp パイプラインを構築
      let sharpInstance = sharp(filePath);

      // メモリ最適化: リサイズ
      if (this.optimizeMemory && (this.maxWidth || this.maxHeight)) {
        sharpInstance = sharpInstance.resize(this.maxWidth, this.maxHeight, {
          fit: 'inside',
          withoutEnlargement: true,
        });
      }

      // RGBAに変換して raw バッファを取得
      const { data, info } = await sharpInstance
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      // フォーマットを判定
      const sharpMetadata = await sharp(filePath).metadata();
      let format: 'png' | 'jpeg';
      if (sharpMetadata.format === 'png') {
        format = 'png';
      } else if (sharpMetadata.format === 'jpeg') {
        format = 'jpeg';
      } else {
        format = 'png'; // デフォルト
      }

      const metadata: FrameLoaderMetadata = {
        path: filePath,
        width: info.width,
        height: info.height,
        channels: info.channels as 3 | 4,
        fileSize: stats.size,
        format,
      };

      if (process.env.NODE_ENV === 'development') {
        // eslint-disable-next-line no-console -- Intentional debug log in development
        console.log('[FrameLoader] Loaded frame:', {
          path: filePath,
          width: info.width,
          height: info.height,
          bufferSize: data.length,
        });
      }

      return {
        metadata,
        buffer: data,
      };
    } catch (error) {
      if (error instanceof FrameLoaderError) {
        throw error;
      }
      throw new FrameLoaderError('LOAD_FAILED', `Failed to load frame: ${error}`, {
        path: filePath,
        originalError: String(error),
      });
    }
  }

  // ==========================================================================
  // フレームペア読み込み
  // ==========================================================================

  /**
   * 2つのフレームをペアで読み込み
   * 差分比較用に同じサイズであることを検証
   *
   * @param path1 - フレーム1のパス
   * @param path2 - フレーム2のパス
   * @returns フレームペア
   * @throws FrameLoaderError パスが無効、サイズ不一致
   */
  async loadFramePair(path1: string, path2: string): Promise<FramePair> {
    // 並列で両フレームを読み込み
    const [frame1, frame2] = await Promise.all([
      this.loadFrame(path1),
      this.loadFrame(path2),
    ]);

    // サイズ一致確認
    if (
      frame1.metadata.width !== frame2.metadata.width ||
      frame1.metadata.height !== frame2.metadata.height
    ) {
      throw new FrameLoaderError(
        'DIMENSION_MISMATCH',
        `Frame size mismatch: ${frame1.metadata.width}x${frame1.metadata.height} vs ${frame2.metadata.width}x${frame2.metadata.height}`,
        {
          frame1: {
            path: path1,
            width: frame1.metadata.width,
            height: frame1.metadata.height,
          },
          frame2: {
            path: path2,
            width: frame2.metadata.width,
            height: frame2.metadata.height,
          },
        }
      );
    }

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[FrameLoader] Loaded frame pair:', {
        frame1: path1,
        frame2: path2,
        size: `${frame1.metadata.width}x${frame1.metadata.height}`,
      });
    }

    return { frame1, frame2 };
  }
}

// ============================================================================
// エクスポート
// ============================================================================

export default FrameLoader;
