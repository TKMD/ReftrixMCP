// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * VideoRecorderService テスト
 * TDD Red Phase: Playwrightを使用した動画録画サービスのテスト
 *
 * 目的:
 * - Playwrightでwebページをクロールしながら動画を録画
 * - フレーム抽出によるモーション検出の基盤提供
 * - リソースクリーンアップ（一時ファイル削除）
 * - タイムアウト処理
 *
 * Phase1: 動画キャプチャ - Playwright録画 + フレーム解析
 *
 * 注意:
 * - Playwrightはモック化して外部ネットワーク依存を排除
 * - ファイルシステム操作は部分的にモック化
 *
 * @module tests/services/page/video-recorder.service
 */

import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// =====================================================
// Playwrightモック定義（ホイスト必須）
// =====================================================

// モックビデオオブジェクト
const mockVideo = {
  path: vi.fn(),
};

// モックページオブジェクト
const mockPage = {
  goto: vi.fn(),
  title: vi.fn(),
  close: vi.fn(),
  video: vi.fn(),
  evaluate: vi.fn(),
  mouse: {
    move: vi.fn(),
  },
};

// モックコンテキストオブジェクト
const mockContext = {
  newPage: vi.fn(),
  close: vi.fn(),
};

// モックブラウザオブジェクト
const mockBrowser = {
  newContext: vi.fn(),
  close: vi.fn(),
};

// Playwrightモジュールのモック（ホイスト）
vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue({
      newContext: vi.fn(),
      close: vi.fn(),
    }),
  },
}));

// loggerモック
vi.mock('../../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

// fsモック（部分的）
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockImplementation((path: string) => {
      // テスト用のモックパスの場合はtrueを返す
      if (typeof path === 'string' && path.includes('video-recorder-')) {
        return true;
      }
      // その他のパスは実際の実装を使用
      return actual.existsSync(path);
    }),
    statSync: vi.fn().mockImplementation((path: string) => {
      // テスト用のモックパスの場合はモックstatsを返す
      if (typeof path === 'string' && path.includes('video-recorder-')) {
        return { size: 102400 }; // 100KB
      }
      // その他のパスは実際の実装を使用
      return actual.statSync(path);
    }),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
    rmdirSync: vi.fn(),
    rmSync: vi.fn(),
    mkdtempSync: vi.fn().mockImplementation((prefix: string) => {
      // テスト用の一時ディレクトリパスを返す
      return `${prefix}mock-12345`;
    }),
  };
});

// =====================================================
// インポート後のモック設定
// =====================================================

// Playwrightのchromiumを取得してモックを設定
import { chromium } from 'playwright';

// =====================================================
// Unit Tests - ネットワークアクセス不要
// =====================================================

describe('VideoRecorderService - Unit Tests', () => {
  // サービスモジュールのインポート
  let VideoRecorderService: typeof import('../../../src/services/page/video-recorder.service').VideoRecorderService;
  let recordPage: typeof import('../../../src/services/page/video-recorder.service').recordPage;
  let closeSharedRecorder: typeof import('../../../src/services/page/video-recorder.service').closeSharedRecorder;
  let DEFAULT_RECORD_OPTIONS: typeof import('../../../src/services/page/video-recorder.service').DEFAULT_RECORD_OPTIONS;
  let RecordError: typeof import('../../../src/services/page/video-recorder.service').RecordError;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // モジュールをリロード
    const module = await import('../../../src/services/page/video-recorder.service');
    VideoRecorderService = module.VideoRecorderService;
    recordPage = module.recordPage;
    closeSharedRecorder = module.closeSharedRecorder;
    DEFAULT_RECORD_OPTIONS = module.DEFAULT_RECORD_OPTIONS;
    RecordError = module.RecordError;
  });

  describe('Module Exports', () => {
    it('VideoRecorderService クラスがエクスポートされていること', () => {
      expect(VideoRecorderService).toBeDefined();
      expect(typeof VideoRecorderService).toBe('function');
    });

    it('recordPage 関数がエクスポートされていること', () => {
      expect(recordPage).toBeDefined();
      expect(typeof recordPage).toBe('function');
    });

    it('closeSharedRecorder 関数がエクスポートされていること', () => {
      expect(closeSharedRecorder).toBeDefined();
      expect(typeof closeSharedRecorder).toBe('function');
    });

    it('DEFAULT_RECORD_OPTIONS がエクスポートされていること', () => {
      expect(DEFAULT_RECORD_OPTIONS).toBeDefined();
    });

    it('RecordError エラークラスがエクスポートされていること', () => {
      expect(RecordError).toBeDefined();
    });
  });

  describe('DEFAULT_RECORD_OPTIONS', () => {
    it('デフォルトタイムアウトが30000msであること', () => {
      expect(DEFAULT_RECORD_OPTIONS.timeout).toBe(30000);
    });

    it('デフォルトviewportが1280x720であること', () => {
      expect(DEFAULT_RECORD_OPTIONS.viewport).toEqual({ width: 1280, height: 720 });
    });

    it('デフォルトrecordSizeが1280x720であること', () => {
      expect(DEFAULT_RECORD_OPTIONS.recordSize).toEqual({ width: 1280, height: 720 });
    });

    it('デフォルトwaitUntilがdomcontentloadedであること（WebGL/3Dサイト対応）', () => {
      // WebGL/3Dサイトでは'load'イベントが非常に遅いため、'domcontentloaded'をデフォルトに変更
      expect(DEFAULT_RECORD_OPTIONS.waitUntil).toBe('domcontentloaded');
    });

    it('デフォルトrecordDurationが5000msであること', () => {
      expect(DEFAULT_RECORD_OPTIONS.recordDuration).toBe(5000);
    });

    it('デフォルトscrollPageがtrueであること', () => {
      expect(DEFAULT_RECORD_OPTIONS.scrollPage).toBe(true);
    });

    it('デフォルトmoveMouseRandomlyがtrueであること', () => {
      expect(DEFAULT_RECORD_OPTIONS.moveMouseRandomly).toBe(true);
    });
  });

  describe('VideoRecorderService Class', () => {
    it('インスタンスを作成できること', () => {
      const service = new VideoRecorderService();
      expect(service).toBeInstanceOf(VideoRecorderService);
    });

    it('recordメソッドが存在すること', () => {
      const service = new VideoRecorderService();
      expect(typeof service.record).toBe('function');
    });

    it('closeメソッドが存在すること', () => {
      const service = new VideoRecorderService();
      expect(typeof service.close).toBe('function');
    });

    it('cleanupメソッドが存在すること（一時ファイル削除用）', () => {
      const service = new VideoRecorderService();
      expect(typeof service.cleanup).toBe('function');
    });
  });

  describe('RecordError Class', () => {
    it('RecordError が正しい名前を持つこと', () => {
      const error = new RecordError('test error message');
      expect(error.name).toBe('RecordError');
      expect(error.message).toBe('test error message');
    });

    it('RecordError が Error を継承すること', () => {
      const error = new RecordError('test');
      expect(error).toBeInstanceOf(Error);
    });

    it('RecordError がstatusCodeを持てること', () => {
      const error = new RecordError('test', 404);
      expect(error.statusCode).toBe(404);
    });
  });

  describe('Input Validation', () => {
    it('空のURLでエラーをスローすること', async () => {
      await expect(recordPage('')).rejects.toThrow(RecordError);
    });

    it('無効なURLでエラーをスローすること', async () => {
      await expect(recordPage('not-a-valid-url')).rejects.toThrow(RecordError);
    });

    it('プロトコルなしのURLでエラーをスローすること', async () => {
      await expect(recordPage('example.com')).rejects.toThrow(RecordError);
    });

    it('fileプロトコルがブロックされること', async () => {
      await expect(recordPage('file:///etc/passwd')).rejects.toThrow(RecordError);
    });

    it('localhostがブロックされること（SSRF対策）', async () => {
      await expect(recordPage('http://localhost:3000')).rejects.toThrow(RecordError);
    });

    it('プライベートIPがブロックされること（SSRF対策）', async () => {
      await expect(recordPage('http://192.168.1.1')).rejects.toThrow(RecordError);
    });

    it('リンクローカル (169.254.x.x) がブロックされること', async () => {
      await expect(recordPage('http://169.254.1.1')).rejects.toThrow(RecordError);
    });

    it('AWSメタデータサービス (169.254.169.254) がブロックされること', async () => {
      await expect(recordPage('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(RecordError);
    });
  });
});

// =====================================================
// Integration Tests - Playwrightモック使用
// =====================================================

describe('VideoRecorderService - Integration Tests (Mocked)', () => {
  // サービスモジュールのインポート
  let VideoRecorderService: typeof import('../../../src/services/page/video-recorder.service').VideoRecorderService;
  let recordPage: typeof import('../../../src/services/page/video-recorder.service').recordPage;
  let closeSharedRecorder: typeof import('../../../src/services/page/video-recorder.service').closeSharedRecorder;
  let RecordError: typeof import('../../../src/services/page/video-recorder.service').RecordError;

  // テスト用の一時ディレクトリ
  let tempDir: string;
  // モックビデオパス
  let mockVideoPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // 一時ディレクトリのパスを設定
    tempDir = path.join(os.tmpdir(), 'video-recorder-mock-12345');
    mockVideoPath = path.join(tempDir, 'video.webm');

    // mockVideoのpath()をモック
    mockVideo.path.mockResolvedValue(mockVideoPath);

    // mockPageの設定
    mockPage.goto.mockResolvedValue({
      status: vi.fn().mockReturnValue(200),
      ok: vi.fn().mockReturnValue(true),
    });
    mockPage.title.mockResolvedValue('Example Domain');
    mockPage.close.mockResolvedValue(undefined);
    mockPage.video.mockReturnValue(mockVideo);
    mockPage.evaluate.mockResolvedValue(undefined);
    mockPage.mouse.move.mockResolvedValue(undefined);

    // mockContextの設定
    mockContext.newPage.mockResolvedValue(mockPage);
    mockContext.close.mockResolvedValue(undefined);

    // mockBrowserの設定
    mockBrowser.newContext.mockResolvedValue(mockContext);
    mockBrowser.close.mockResolvedValue(undefined);

    // chromium.launchのモック設定
    vi.mocked(chromium.launch).mockResolvedValue(mockBrowser as unknown as import('playwright').Browser);

    // モジュールをリロード
    const module = await import('../../../src/services/page/video-recorder.service');
    VideoRecorderService = module.VideoRecorderService;
    recordPage = module.recordPage;
    closeSharedRecorder = module.closeSharedRecorder;
    RecordError = module.RecordError;
  });

  afterEach(async () => {
    // 共有サービスのクリーンアップ
    try {
      await closeSharedRecorder();
    } catch {
      // クリーンアップエラーは無視
    }
  });

  afterAll(async () => {
    // 共有サービスのクリーンアップ
    try {
      const module = await import('../../../src/services/page/video-recorder.service');
      await module.closeSharedRecorder();
    } catch {
      // モジュールが存在しない場合は無視
    }
  });

  describe('Basic Recording', () => {
    it('example.comから動画を録画できること', async () => {
      // テスト: 動画録画の基本フロー
      const result = await recordPage('https://example.com', {
        timeout: 30000,
        recordDuration: 100, // 短い録画時間（テスト高速化）
        scrollPage: false,
        moveMouseRandomly: false,
      });

      expect(result).toHaveProperty('videoPath');
      expect(result).toHaveProperty('durationMs');
      expect(result).toHaveProperty('sizeBytes');
      expect(result).toHaveProperty('processingTimeMs');

      // 動画パスが正しいこと
      expect(result.videoPath).toBe(mockVideoPath);

      // 動画サイズが正の値であること（モック値: 100KB）
      expect(result.sizeBytes).toBeGreaterThan(0);

      // 録画時間が指定した時間であること
      expect(result.durationMs).toBe(100);
    }, 10000);

    it('録画結果にページタイトルが含まれること', async () => {
      const result = await recordPage('https://example.com', {
        timeout: 30000,
        recordDuration: 100,
        scrollPage: false,
        moveMouseRandomly: false,
      });

      expect(result.title).toBeDefined();
      expect(typeof result.title).toBe('string');
      expect(result.title?.toLowerCase()).toContain('example');
    }, 10000);

    it('webm形式で録画されること', async () => {
      const result = await recordPage('https://example.com', {
        timeout: 30000,
        recordDuration: 100,
        scrollPage: false,
        moveMouseRandomly: false,
      });

      // ファイル拡張子がwebmであること
      expect(result.videoPath.endsWith('.webm')).toBe(true);
    }, 10000);
  });

  describe('Options Handling', () => {
    it('カスタムviewportが適用されること', async () => {
      const result = await recordPage('https://example.com', {
        timeout: 30000,
        viewport: { width: 1920, height: 1080 },
        recordDuration: 100,
        scrollPage: false,
        moveMouseRandomly: false,
      });

      expect(result).toHaveProperty('videoPath');
      expect(result.videoPath).toBe(mockVideoPath);

      // viewportが設定されたことを確認
      expect(mockBrowser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({
          viewport: { width: 1920, height: 1080 },
        })
      );
    }, 10000);

    it('カスタムrecordSizeが適用されること', async () => {
      const result = await recordPage('https://example.com', {
        timeout: 30000,
        viewport: { width: 1920, height: 1080 },
        recordSize: { width: 640, height: 480 }, // 異なるサイズで録画
        recordDuration: 100,
        scrollPage: false,
        moveMouseRandomly: false,
      });

      expect(result).toHaveProperty('videoPath');
      expect(result.videoPath).toBe(mockVideoPath);

      // recordSizeが設定されたことを確認
      expect(mockBrowser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({
          recordVideo: expect.objectContaining({
            size: { width: 640, height: 480 },
          }),
        })
      );
    }, 10000);

    it('waitUntil: networkidleオプションが適用されること', async () => {
      const result = await recordPage('https://example.com', {
        timeout: 30000,
        waitUntil: 'networkidle',
        recordDuration: 100,
        scrollPage: false,
        moveMouseRandomly: false,
      });

      expect(result).toHaveProperty('videoPath');

      // waitUntilが設定されたことを確認
      expect(mockPage.goto).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          waitUntil: 'networkidle',
        })
      );
    }, 10000);

    it('scrollPage: falseで録画できること', async () => {
      const result = await recordPage('https://example.com', {
        timeout: 30000,
        scrollPage: false,
        recordDuration: 100,
        moveMouseRandomly: false,
      });

      expect(result).toHaveProperty('videoPath');
      // scrollPageがfalseなのでevaluate（スクロール）は呼ばれない
      expect(mockPage.evaluate).not.toHaveBeenCalled();
    }, 10000);

    it('moveMouseRandomly: falseで録画できること', async () => {
      const result = await recordPage('https://example.com', {
        timeout: 30000,
        moveMouseRandomly: false,
        recordDuration: 100,
        scrollPage: false,
      });

      expect(result).toHaveProperty('videoPath');
      // moveMouseRandomlyがfalseなのでmouse.moveは呼ばれない
      expect(mockPage.mouse.move).not.toHaveBeenCalled();
    }, 10000);
  });

  describe('Error Handling', () => {
    it('タイムアウト時にRecordErrorをスローすること', async () => {
      // gotoでタイムアウトエラーをシミュレート
      mockPage.goto.mockRejectedValueOnce(new Error('Timeout exceeded: 1ms'));

      await expect(
        recordPage('https://example.com', { timeout: 1 })
      ).rejects.toThrow(RecordError);
    }, 10000);

    it('存在しないドメインでRecordErrorをスローすること', async () => {
      // DNS解決エラーをシミュレート
      mockPage.goto.mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'));

      await expect(
        recordPage('https://this-domain-definitely-does-not-exist-12345.com', {
          timeout: 10000,
        })
      ).rejects.toThrow(RecordError);
    }, 10000);

    it('404レスポンスでRecordErrorをスローすること', async () => {
      // 404レスポンスをシミュレート
      mockPage.goto.mockResolvedValueOnce({
        status: vi.fn().mockReturnValue(404),
        ok: vi.fn().mockReturnValue(false),
      });

      await expect(
        recordPage('https://httpstat.us/404', { timeout: 30000 })
      ).rejects.toThrow(RecordError);
    }, 10000);
  });

  describe('Resource Cleanup', () => {
    it('録画後に一時ファイルが残らないこと（cleanup呼び出し後）', async () => {
      const service = new VideoRecorderService();

      // ブラウザとコンテキストのモックを設定
      vi.mocked(chromium.launch).mockResolvedValue(mockBrowser as unknown as import('playwright').Browser);

      const result = await service.record('https://example.com', {
        timeout: 30000,
        recordDuration: 100,
        scrollPage: false,
        moveMouseRandomly: false,
      });

      const videoPath = result.videoPath;
      expect(videoPath).toBe(mockVideoPath);

      // cleanup呼び出し
      await service.cleanup(videoPath);

      // ファイル削除が呼ばれたことを確認
      expect(fs.unlinkSync).toHaveBeenCalledWith(videoPath);
    }, 10000);

    it('closeメソッドが正常に動作すること', async () => {
      const service = new VideoRecorderService();

      // ブラウザとコンテキストのモックを設定
      vi.mocked(chromium.launch).mockResolvedValue(mockBrowser as unknown as import('playwright').Browser);

      await service.record('https://example.com', {
        timeout: 30000,
        recordDuration: 100,
        scrollPage: false,
        moveMouseRandomly: false,
      });

      await expect(service.close()).resolves.not.toThrow();

      // ブラウザが閉じられたことを確認
      expect(mockBrowser.close).toHaveBeenCalled();
    }, 10000);
  });

  describe('VideoRecorderService Instance', () => {
    it('インスタンスメソッドで録画できること', async () => {
      const service = new VideoRecorderService();

      // ブラウザとコンテキストのモックを設定
      vi.mocked(chromium.launch).mockResolvedValue(mockBrowser as unknown as import('playwright').Browser);

      const result = await service.record('https://example.com', {
        timeout: 30000,
        recordDuration: 100,
        scrollPage: false,
        moveMouseRandomly: false,
      });

      expect(result).toHaveProperty('videoPath');
      expect(result).toHaveProperty('durationMs');
      expect(result).toHaveProperty('sizeBytes');
      expect(result).toHaveProperty('processingTimeMs');

      await service.close();
    }, 10000);
  });
});

// =====================================================
// RecordResult Schema Validation Tests
// =====================================================

describe('RecordResult Schema (Mocked)', () => {
  // サービスモジュールのインポート
  let recordPage: typeof import('../../../src/services/page/video-recorder.service').recordPage;
  let closeSharedRecorder: typeof import('../../../src/services/page/video-recorder.service').closeSharedRecorder;

  // テスト用の一時ディレクトリ
  let tempDir: string;
  // モックビデオパス
  let mockVideoPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // 一時ディレクトリのパスを設定
    tempDir = path.join(os.tmpdir(), 'video-recorder-mock-12345');
    mockVideoPath = path.join(tempDir, 'video.webm');

    // mockVideoのpath()をモック
    mockVideo.path.mockResolvedValue(mockVideoPath);

    // mockPageの設定
    mockPage.goto.mockResolvedValue({
      status: vi.fn().mockReturnValue(200),
      ok: vi.fn().mockReturnValue(true),
    });
    mockPage.title.mockResolvedValue('Example Domain');
    mockPage.close.mockResolvedValue(undefined);
    mockPage.video.mockReturnValue(mockVideo);
    mockPage.evaluate.mockResolvedValue(undefined);
    mockPage.mouse.move.mockResolvedValue(undefined);

    // mockContextの設定
    mockContext.newPage.mockResolvedValue(mockPage);
    mockContext.close.mockResolvedValue(undefined);

    // mockBrowserの設定
    mockBrowser.newContext.mockResolvedValue(mockContext);
    mockBrowser.close.mockResolvedValue(undefined);

    // chromium.launchのモック設定
    vi.mocked(chromium.launch).mockResolvedValue(mockBrowser as unknown as import('playwright').Browser);

    // モジュールをリロード
    const module = await import('../../../src/services/page/video-recorder.service');
    recordPage = module.recordPage;
    closeSharedRecorder = module.closeSharedRecorder;
  });

  afterEach(async () => {
    try {
      await closeSharedRecorder();
    } catch {
      // クリーンアップエラーは無視
    }
  });

  it('RecordResultが必須フィールドを持つこと', async () => {
    const result = await recordPage('https://example.com', {
      timeout: 30000,
      recordDuration: 100,
      scrollPage: false,
      moveMouseRandomly: false,
    });

    // 必須フィールドの検証
    expect(typeof result.videoPath).toBe('string');
    expect(typeof result.durationMs).toBe('number');
    expect(typeof result.sizeBytes).toBe('number');
    expect(typeof result.processingTimeMs).toBe('number');

    // 値の妥当性
    expect(result.videoPath.length).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.processingTimeMs).toBeGreaterThan(0);
  }, 10000);

  it('titleがオプショナルであること', async () => {
    const result = await recordPage('https://example.com', {
      timeout: 30000,
      recordDuration: 100,
      scrollPage: false,
      moveMouseRandomly: false,
    });

    // titleは存在すれば文字列、存在しなければundefined
    if (result.title !== undefined) {
      expect(typeof result.title).toBe('string');
    }
  }, 10000);
});

// =====================================================
// Performance Tests
// =====================================================

describe('VideoRecorderService - Performance (Mocked)', () => {
  // サービスモジュールのインポート
  let recordPage: typeof import('../../../src/services/page/video-recorder.service').recordPage;
  let closeSharedRecorder: typeof import('../../../src/services/page/video-recorder.service').closeSharedRecorder;

  // テスト用の一時ディレクトリ
  let tempDir: string;
  // モックビデオパス
  let mockVideoPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // 一時ディレクトリのパスを設定
    tempDir = path.join(os.tmpdir(), 'video-recorder-mock-12345');
    mockVideoPath = path.join(tempDir, 'video.webm');

    // mockVideoのpath()をモック
    mockVideo.path.mockResolvedValue(mockVideoPath);

    // mockPageの設定
    mockPage.goto.mockResolvedValue({
      status: vi.fn().mockReturnValue(200),
      ok: vi.fn().mockReturnValue(true),
    });
    mockPage.title.mockResolvedValue('Example Domain');
    mockPage.close.mockResolvedValue(undefined);
    mockPage.video.mockReturnValue(mockVideo);
    mockPage.evaluate.mockResolvedValue(undefined);
    mockPage.mouse.move.mockResolvedValue(undefined);

    // mockContextの設定
    mockContext.newPage.mockResolvedValue(mockPage);
    mockContext.close.mockResolvedValue(undefined);

    // mockBrowserの設定
    mockBrowser.newContext.mockResolvedValue(mockContext);
    mockBrowser.close.mockResolvedValue(undefined);

    // chromium.launchのモック設定
    vi.mocked(chromium.launch).mockResolvedValue(mockBrowser as unknown as import('playwright').Browser);

    // モジュールをリロード
    const module = await import('../../../src/services/page/video-recorder.service');
    recordPage = module.recordPage;
    closeSharedRecorder = module.closeSharedRecorder;
  });

  afterEach(async () => {
    try {
      await closeSharedRecorder();
    } catch {
      // クリーンアップエラーは無視
    }
  });

  it('短い録画（100ms）が5秒以内に完了すること', async () => {
    const startTime = Date.now();
    await recordPage('https://example.com', {
      timeout: 30000,
      recordDuration: 100,
      scrollPage: false,
      moveMouseRandomly: false,
    });
    const elapsed = Date.now() - startTime;

    // モック化されているので非常に高速に完了するはず
    expect(elapsed).toBeLessThan(5000);
  }, 10000);

  it('processingTimeMsが実際の処理時間を反映すること', async () => {
    const startTime = Date.now();
    const result = await recordPage('https://example.com', {
      timeout: 30000,
      recordDuration: 100,
      scrollPage: false,
      moveMouseRandomly: false,
    });
    const elapsed = Date.now() - startTime;

    // processingTimeMsが妥当な範囲であること
    // モック化されているので実際の経過時間と近いはず
    expect(result.processingTimeMs).toBeGreaterThan(0);
    expect(result.processingTimeMs).toBeLessThan(elapsed + 1000); // 多少のオーバーヘッドを許容
  }, 10000);
});

// =====================================================
// Concurrent Recording Tests
// =====================================================

describe('VideoRecorderService - Concurrent Recording (Mocked)', () => {
  // サービスモジュールのインポート
  let recordPage: typeof import('../../../src/services/page/video-recorder.service').recordPage;
  let closeSharedRecorder: typeof import('../../../src/services/page/video-recorder.service').closeSharedRecorder;

  // テスト用の一時ディレクトリ
  let tempDir: string;
  // モックビデオパス
  let mockVideoPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // 一時ディレクトリのパスを設定
    tempDir = path.join(os.tmpdir(), 'video-recorder-mock-12345');
    mockVideoPath = path.join(tempDir, 'video.webm');

    // mockVideoのpath()をモック
    mockVideo.path.mockResolvedValue(mockVideoPath);

    // mockPageの設定
    mockPage.goto.mockResolvedValue({
      status: vi.fn().mockReturnValue(200),
      ok: vi.fn().mockReturnValue(true),
    });
    mockPage.title.mockResolvedValue('Example Domain');
    mockPage.close.mockResolvedValue(undefined);
    mockPage.video.mockReturnValue(mockVideo);
    mockPage.evaluate.mockResolvedValue(undefined);
    mockPage.mouse.move.mockResolvedValue(undefined);

    // mockContextの設定
    mockContext.newPage.mockResolvedValue(mockPage);
    mockContext.close.mockResolvedValue(undefined);

    // mockBrowserの設定
    mockBrowser.newContext.mockResolvedValue(mockContext);
    mockBrowser.close.mockResolvedValue(undefined);

    // chromium.launchのモック設定
    vi.mocked(chromium.launch).mockResolvedValue(mockBrowser as unknown as import('playwright').Browser);

    // モジュールをリロード
    const module = await import('../../../src/services/page/video-recorder.service');
    recordPage = module.recordPage;
    closeSharedRecorder = module.closeSharedRecorder;
  });

  afterEach(async () => {
    try {
      await closeSharedRecorder();
    } catch {
      // クリーンアップエラーは無視
    }
  });

  it('複数の録画を並行実行できること', async () => {
    const urls = ['https://example.com', 'https://example.org'];

    const results = await Promise.all(
      urls.map((url) =>
        recordPage(url, {
          timeout: 30000,
          recordDuration: 100,
          scrollPage: false,
          moveMouseRandomly: false,
        })
      )
    );

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result).toHaveProperty('videoPath');
      expect(result.videoPath).toContain('video-recorder-');
    }
  }, 10000);
});
