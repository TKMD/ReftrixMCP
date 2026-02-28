// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Frame Loader Tests (TDD)
 *
 * Sharp を使用したフレーム画像読み込みモジュールのテスト
 *
 * @module @reftrix/mcp-server/tests/services/motion/frame-loader
 *
 * テスト対象:
 * 1. loadFrame(path): 単一フレーム読み込み
 * 2. loadFramePair(path1, path2): ペア読み込み
 * 3. validateFramePath(path): パス検証
 * 4. getFrameMetadata(path): メタデータ取得
 *
 * セキュリティ要件:
 * - パストラバーサル防止（../ 検出）
 * - 許可ディレクトリ外アクセス拒否
 * - ファイルサイズ上限チェック（10MB）
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import sharp from 'sharp';
import { FrameLoader } from '../../../src/services/motion/infrastructure/frame-loader';
import {
  FrameLoaderError,
  type FrameLoaderOptions,
} from '../../../src/services/motion/types';

// ============================================================================
// テストフィクスチャ
// ============================================================================

/**
 * テスト用一時ディレクトリとテスト画像を作成
 */
let testDir: string;
let testPngPath: string;
let testPng2Path: string;
let testJpegPath: string;
let outsideDir: string;
let outsideFilePath: string;

beforeAll(async () => {
  // 一時ディレクトリを作成
  testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'frame-loader-test-'));
  outsideDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'outside-test-'));

  // テスト用PNG画像を作成（100x100、赤色）
  testPngPath = path.join(testDir, 'frame_001.png');
  await sharp({
    create: {
      width: 100,
      height: 100,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toFile(testPngPath);

  // 2つ目のテスト用PNG画像（100x100、青色）
  testPng2Path = path.join(testDir, 'frame_002.png');
  await sharp({
    create: {
      width: 100,
      height: 100,
      channels: 4,
      background: { r: 0, g: 0, b: 255, alpha: 1 },
    },
  })
    .png()
    .toFile(testPng2Path);

  // テスト用JPEG画像を作成
  testJpegPath = path.join(testDir, 'frame_001.jpg');
  await sharp({
    create: {
      width: 100,
      height: 100,
      channels: 3,
      background: { r: 0, g: 255, b: 0 },
    },
  })
    .jpeg()
    .toFile(testJpegPath);

  // 許可ディレクトリ外のファイル
  outsideFilePath = path.join(outsideDir, 'outside.png');
  await sharp({
    create: {
      width: 50,
      height: 50,
      channels: 4,
      background: { r: 128, g: 128, b: 128, alpha: 1 },
    },
  })
    .png()
    .toFile(outsideFilePath);
});

afterAll(async () => {
  // テスト用ファイルとディレクトリを削除
  try {
    await fs.promises.rm(testDir, { recursive: true, force: true });
    await fs.promises.rm(outsideDir, { recursive: true, force: true });
  } catch {
    // クリーンアップ失敗は無視
  }
});

// ============================================================================
// validateFramePath テスト
// ============================================================================

describe('FrameLoader - validateFramePath', () => {
  let loader: FrameLoader;

  beforeEach(() => {
    loader = new FrameLoader({ allowedDirectories: [testDir] });
  });

  describe('正常系', () => {
    it('有効なPNGパスを検証できる', async () => {
      const result = await loader.validateFramePath(testPngPath);

      expect(result.isValid).toBe(true);
      expect(result.normalizedPath).toBe(testPngPath);
      expect(result.errorCode).toBeUndefined();
      expect(result.errorMessage).toBeUndefined();
    });

    it('有効なJPEGパスを検証できる', async () => {
      const result = await loader.validateFramePath(testJpegPath);

      expect(result.isValid).toBe(true);
      expect(result.normalizedPath).toBe(testJpegPath);
    });
  });

  describe('パストラバーサル検出', () => {
    it('../ を含むパスを拒否する', async () => {
      // path.joinではなく文字列連結を使用（path.joinは自動正規化してしまうため）
      const maliciousPath = testDir + '/../etc/passwd';
      const result = await loader.validateFramePath(maliciousPath);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('PATH_TRAVERSAL');
      expect(result.errorMessage).toContain('traversal');
    });

    it('..\\（Windows形式）を含むパスを拒否する', async () => {
      const maliciousPath = testDir + '\\..\\etc\\passwd';
      const result = await loader.validateFramePath(maliciousPath);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('PATH_TRAVERSAL');
    });

    it('URLエンコードされた..を拒否する', async () => {
      const maliciousPath = path.join(testDir, '%2e%2e', 'etc', 'passwd');
      const result = await loader.validateFramePath(maliciousPath);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('PATH_TRAVERSAL');
    });
  });

  describe('許可ディレクトリ検証', () => {
    it('許可ディレクトリ外のパスを拒否する', async () => {
      const result = await loader.validateFramePath(outsideFilePath);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('OUTSIDE_ALLOWED_DIR');
      expect(result.errorMessage).toContain('allowed');
    });
  });

  describe('拡張子検証', () => {
    it('サポートされていない拡張子を拒否する', async () => {
      const invalidPath = path.join(testDir, 'file.gif');
      const result = await loader.validateFramePath(invalidPath);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('INVALID_EXTENSION');
      expect(result.errorMessage).toContain('extension');
    });

    it('.txt 拡張子を拒否する', async () => {
      const invalidPath = path.join(testDir, 'file.txt');
      const result = await loader.validateFramePath(invalidPath);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('INVALID_EXTENSION');
    });
  });

  describe('ファイル存在確認', () => {
    it('存在しないファイルを検出する', async () => {
      const nonExistentPath = path.join(testDir, 'nonexistent.png');
      const result = await loader.validateFramePath(nonExistentPath);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('FILE_NOT_FOUND');
    });
  });

  describe('ファイルサイズ検証', () => {
    it('サイズ上限を超えるファイルを拒否する', async () => {
      // 小さいmaxFileSizeで新しいloaderを作成
      const smallLoader = new FrameLoader({
        allowedDirectories: [testDir],
        maxFileSize: 100, // 100バイト
      });

      const result = await smallLoader.validateFramePath(testPngPath);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('FILE_TOO_LARGE');
      expect(result.errorMessage).toContain('size');
    });
  });
});

// ============================================================================
// getFrameMetadata テスト
// ============================================================================

describe('FrameLoader - getFrameMetadata', () => {
  let loader: FrameLoader;

  beforeEach(() => {
    loader = new FrameLoader({ allowedDirectories: [testDir] });
  });

  describe('正常系', () => {
    it('PNGファイルのメタデータを取得できる', async () => {
      const metadata = await loader.getFrameMetadata(testPngPath);

      expect(metadata.path).toBe(testPngPath);
      expect(metadata.width).toBe(100);
      expect(metadata.height).toBe(100);
      expect(metadata.channels).toBe(4); // RGBA
      expect(metadata.format).toBe('png');
      expect(metadata.fileSize).toBeGreaterThan(0);
    });

    it('JPEGファイルのメタデータを取得できる', async () => {
      const metadata = await loader.getFrameMetadata(testJpegPath);

      expect(metadata.path).toBe(testJpegPath);
      expect(metadata.width).toBe(100);
      expect(metadata.height).toBe(100);
      expect(metadata.channels).toBe(3); // RGB
      expect(metadata.format).toBe('jpeg');
      expect(metadata.fileSize).toBeGreaterThan(0);
    });
  });

  describe('エラー系', () => {
    it('無効なパスでエラーをスローする', async () => {
      // path.joinではなく文字列連結を使用（path.joinは自動正規化してしまうため）
      const invalidPath = testDir + '/../etc/passwd';

      await expect(loader.getFrameMetadata(invalidPath)).rejects.toThrow(
        FrameLoaderError
      );
    });

    it('存在しないファイルでエラーをスローする', async () => {
      const nonExistentPath = path.join(testDir, 'nonexistent.png');

      await expect(loader.getFrameMetadata(nonExistentPath)).rejects.toThrow(
        FrameLoaderError
      );
    });
  });
});

// ============================================================================
// loadFrame テスト
// ============================================================================

describe('FrameLoader - loadFrame', () => {
  let loader: FrameLoader;

  beforeEach(() => {
    loader = new FrameLoader({ allowedDirectories: [testDir] });
  });

  describe('正常系', () => {
    it('PNGフレームを読み込める', async () => {
      const frameData = await loader.loadFrame(testPngPath);

      expect(frameData.metadata.path).toBe(testPngPath);
      expect(frameData.metadata.width).toBe(100);
      expect(frameData.metadata.height).toBe(100);
      expect(frameData.metadata.format).toBe('png');
      expect(frameData.buffer).toBeInstanceOf(Buffer);
      // 100x100 * 4チャンネル = 40000バイト
      expect(frameData.buffer.length).toBe(100 * 100 * 4);
    });

    it('JPEGフレームを読み込める', async () => {
      const frameData = await loader.loadFrame(testJpegPath);

      expect(frameData.metadata.path).toBe(testJpegPath);
      expect(frameData.metadata.width).toBe(100);
      expect(frameData.metadata.height).toBe(100);
      expect(frameData.metadata.format).toBe('jpeg');
      expect(frameData.buffer).toBeInstanceOf(Buffer);
      // JPEGもRGBAに変換される
      expect(frameData.buffer.length).toBe(100 * 100 * 4);
    });

    it('ピクセルデータが正しい（赤色PNG）', async () => {
      const frameData = await loader.loadFrame(testPngPath);

      // 最初のピクセルをチェック（RGBA: 赤）
      expect(frameData.buffer[0]).toBe(255); // R
      expect(frameData.buffer[1]).toBe(0); // G
      expect(frameData.buffer[2]).toBe(0); // B
      expect(frameData.buffer[3]).toBe(255); // A
    });
  });

  describe('エラー系', () => {
    it('パストラバーサルでエラーをスローする', async () => {
      // path.joinではなく文字列連結を使用（path.joinは自動正規化してしまうため）
      const maliciousPath = testDir + '/../etc/passwd';

      await expect(loader.loadFrame(maliciousPath)).rejects.toThrow(FrameLoaderError);
      await expect(loader.loadFrame(maliciousPath)).rejects.toThrow(/traversal/i);
    });

    it('許可ディレクトリ外でエラーをスローする', async () => {
      await expect(loader.loadFrame(outsideFilePath)).rejects.toThrow(FrameLoaderError);
      await expect(loader.loadFrame(outsideFilePath)).rejects.toThrow(/allowed/i);
    });

    it('存在しないファイルでエラーをスローする', async () => {
      const nonExistentPath = path.join(testDir, 'nonexistent.png');

      await expect(loader.loadFrame(nonExistentPath)).rejects.toThrow(FrameLoaderError);
    });

    it('サイズ上限超過でエラーをスローする', async () => {
      const smallLoader = new FrameLoader({
        allowedDirectories: [testDir],
        maxFileSize: 100,
      });

      await expect(smallLoader.loadFrame(testPngPath)).rejects.toThrow(FrameLoaderError);
      await expect(smallLoader.loadFrame(testPngPath)).rejects.toThrow(/size/i);
    });
  });

  describe('メモリ最適化オプション', () => {
    it('最大幅を超える画像をリサイズする', async () => {
      // 大きな画像を作成
      const largePath = path.join(testDir, 'large_frame.png');
      await sharp({
        create: {
          width: 4000,
          height: 3000,
          channels: 4,
          background: { r: 100, g: 100, b: 100, alpha: 1 },
        },
      })
        .png()
        .toFile(largePath);

      const optimizedLoader = new FrameLoader({
        allowedDirectories: [testDir],
        optimizeMemory: true,
        maxWidth: 1920,
        maxHeight: 1080,
      });

      const frameData = await optimizedLoader.loadFrame(largePath);

      // アスペクト比を維持してリサイズ
      expect(frameData.metadata.width).toBeLessThanOrEqual(1920);
      expect(frameData.metadata.height).toBeLessThanOrEqual(1080);

      // クリーンアップ
      await fs.promises.unlink(largePath);
    });
  });
});

// ============================================================================
// loadFramePair テスト
// ============================================================================

describe('FrameLoader - loadFramePair', () => {
  let loader: FrameLoader;

  beforeEach(() => {
    loader = new FrameLoader({ allowedDirectories: [testDir] });
  });

  describe('正常系', () => {
    it('2つのフレームをペアで読み込める', async () => {
      const pair = await loader.loadFramePair(testPngPath, testPng2Path);

      expect(pair.frame1.metadata.path).toBe(testPngPath);
      expect(pair.frame2.metadata.path).toBe(testPng2Path);
      expect(pair.frame1.buffer.length).toBe(pair.frame2.buffer.length);
    });

    it('フレーム1が赤、フレーム2が青であることを確認', async () => {
      const pair = await loader.loadFramePair(testPngPath, testPng2Path);

      // フレーム1: 赤
      expect(pair.frame1.buffer[0]).toBe(255); // R
      expect(pair.frame1.buffer[1]).toBe(0); // G
      expect(pair.frame1.buffer[2]).toBe(0); // B

      // フレーム2: 青
      expect(pair.frame2.buffer[0]).toBe(0); // R
      expect(pair.frame2.buffer[1]).toBe(0); // G
      expect(pair.frame2.buffer[2]).toBe(255); // B
    });

    it('同じサイズのフレームであることを確認', async () => {
      const pair = await loader.loadFramePair(testPngPath, testPng2Path);

      expect(pair.frame1.metadata.width).toBe(pair.frame2.metadata.width);
      expect(pair.frame1.metadata.height).toBe(pair.frame2.metadata.height);
    });
  });

  describe('エラー系', () => {
    it('パス1が無効な場合エラーをスローする', async () => {
      // path.joinではなく文字列連結を使用（path.joinは自動正規化してしまうため）
      const invalidPath = testDir + '/../etc/passwd';

      await expect(loader.loadFramePair(invalidPath, testPng2Path)).rejects.toThrow(
        FrameLoaderError
      );
    });

    it('パス2が無効な場合エラーをスローする', async () => {
      // path.joinではなく文字列連結を使用（path.joinは自動正規化してしまうため）
      const invalidPath = testDir + '/../etc/passwd';

      await expect(loader.loadFramePair(testPngPath, invalidPath)).rejects.toThrow(
        FrameLoaderError
      );
    });

    it('サイズが異なるフレームでエラーをスローする', async () => {
      // 異なるサイズの画像を作成
      const differentSizePath = path.join(testDir, 'different_size.png');
      await sharp({
        create: {
          width: 200,
          height: 200,
          channels: 4,
          background: { r: 0, g: 255, b: 0, alpha: 1 },
        },
      })
        .png()
        .toFile(differentSizePath);

      await expect(
        loader.loadFramePair(testPngPath, differentSizePath)
      ).rejects.toThrow(FrameLoaderError);
      await expect(
        loader.loadFramePair(testPngPath, differentSizePath)
      ).rejects.toThrow(/size/i);

      // クリーンアップ
      await fs.promises.unlink(differentSizePath);
    });
  });
});

// ============================================================================
// FrameLoaderError テスト
// ============================================================================

describe('FrameLoaderError', () => {
  it('エラーコードとメッセージを持つ', () => {
    const error = new FrameLoaderError('PATH_TRAVERSAL', 'Path traversal detected');

    expect(error.code).toBe('PATH_TRAVERSAL');
    expect(error.message).toBe('Path traversal detected');
    expect(error.name).toBe('FrameLoaderError');
  });

  it('Errorを継承している', () => {
    const error = new FrameLoaderError('FILE_NOT_FOUND', 'File not found');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(FrameLoaderError);
  });
});

// ============================================================================
// FrameLoader オプション テスト
// ============================================================================

describe('FrameLoader - オプション設定', () => {
  it('デフォルトオプションで初期化できる', () => {
    const loader = new FrameLoader();

    expect(loader).toBeInstanceOf(FrameLoader);
  });

  it('カスタムオプションで初期化できる', () => {
    const options: FrameLoaderOptions = {
      allowedDirectories: ['/custom/path'],
      maxFileSize: 5 * 1024 * 1024, // 5MB
      optimizeMemory: true,
      maxWidth: 1280,
      maxHeight: 720,
    };

    const loader = new FrameLoader(options);

    expect(loader).toBeInstanceOf(FrameLoader);
  });

  it('複数の許可ディレクトリを設定できる', async () => {
    const loader = new FrameLoader({
      allowedDirectories: [testDir, outsideDir],
    });

    // 両方のディレクトリ内のファイルにアクセス可能
    const result1 = await loader.validateFramePath(testPngPath);
    const result2 = await loader.validateFramePath(outsideFilePath);

    expect(result1.isValid).toBe(true);
    expect(result2.isValid).toBe(true);
  });
});
