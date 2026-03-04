// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OllamaReadinessProbe テスト
 *
 * P2-8: VRAM状態チェック + Ollama接続確認のテスト
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// child_process.execFile をモック
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

// node:util の promisify をモック（execFileAsync として使用される）
vi.mock('util', async (importOriginal) => {
  const original = await importOriginal<typeof import('util')>();
  return {
    ...original,
    promisify: (fn: unknown) => {
      // execFile用のモック関数を返す
      return vi.fn();
    },
  };
});

// fetch をモック
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// HardwareDetector (Apple Silicon判定用)
import { HardwareDetector } from '../../../src/services/vision/hardware-detector.js';

describe('OllamaReadinessProbe', () => {
  let OllamaReadinessProbe: typeof import('../../../src/services/vision/ollama-readiness-probe').OllamaReadinessProbe;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Dynamic import to get fresh module
    const module = await import('../../../src/services/vision/ollama-readiness-probe');
    OllamaReadinessProbe = module.OllamaReadinessProbe;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('デフォルト設定でインスタンスが生成される', () => {
      const probe = new OllamaReadinessProbe();
      expect(probe).toBeDefined();
    });

    it('カスタム設定でインスタンスが生成される', () => {
      const probe = new OllamaReadinessProbe({
        ollamaUrl: 'http://custom:11434',
        minVramFreeMb: 4096,
        maxWaitRetries: 5,
        waitBaseDelayMs: 5000,
        skipVramCheck: true,
      });
      expect(probe).toBeDefined();
    });
  });

  describe('check', () => {
    it('Ollama未接続時はready=falseを返す', async () => {
      // Ollama接続チェック失敗
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const probe = new OllamaReadinessProbe();
      const result = await probe.check();

      expect(result.ready).toBe(false);
      expect(result.ollamaAvailable).toBe(false);
      expect(result.reason).toContain('not available');
    });

    it('skipVramCheck=trueの場合はVRAMチェックをスキップしてready=trueを返す', async () => {
      // Ollama接続成功
      mockFetch.mockResolvedValueOnce({ ok: true });

      const probe = new OllamaReadinessProbe({ skipVramCheck: true });
      const result = await probe.check();

      expect(result.ready).toBe(true);
      expect(result.ollamaAvailable).toBe(true);
      expect(result.vram).toBeNull();
      expect(result.waitRetries).toBe(0);
    });

    it('Ollama接続チェックのタイムアウトが発生した場合はready=falseを返す', async () => {
      // AbortError をシミュレート
      mockFetch.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));

      const probe = new OllamaReadinessProbe();
      const result = await probe.check();

      expect(result.ready).toBe(false);
      expect(result.ollamaAvailable).toBe(false);
    });

    it('Ollama接続チェックで非200レスポンスの場合はready=falseを返す', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

      const probe = new OllamaReadinessProbe();
      const result = await probe.check();

      expect(result.ready).toBe(false);
      expect(result.ollamaAvailable).toBe(false);
    });
  });

  describe('getVramInfo', () => {
    it('nvidia-smi未インストール時はnullを返す', async () => {
      const probe = new OllamaReadinessProbe();
      // queryVram はプライベートだが、getVramInfo 経由でテスト可能
      // execFileAsync がモックされているため、デフォルトで例外が発生しnullが返る
      const info = await probe.getVramInfo();
      expect(info).toBeNull();
    });
  });

  describe('Apple Silicon log message', () => {
    it('Apple Silicon環境: reason に "Apple Silicon detected" が含まれる', async () => {
      // Arrange: Ollama available, queryVram returns null (default mock behavior)
      mockFetch.mockResolvedValueOnce({ ok: true });
      vi.spyOn(HardwareDetector, 'isAppleSilicon').mockReturnValue(true);

      const probe = new OllamaReadinessProbe();
      const result = await probe.check();

      // Assert: ready=true (nvidia-smi not available is not a failure), reason reflects Apple Silicon
      expect(result.ready).toBe(true);
      expect(result.ollamaAvailable).toBe(true);
      expect(result.reason).toContain('Apple Silicon detected');
      expect(result.reason).toContain('Metal GPU');
    });

    it('Linux CPU環境: reason に "assuming CPU mode" が含まれる', async () => {
      // Arrange: Ollama available, queryVram returns null (default mock behavior)
      mockFetch.mockResolvedValueOnce({ ok: true });
      vi.spyOn(HardwareDetector, 'isAppleSilicon').mockReturnValue(false);

      const probe = new OllamaReadinessProbe();
      const result = await probe.check();

      // Assert: Fallback message for non-Apple Silicon environments
      expect(result.ready).toBe(true);
      expect(result.ollamaAvailable).toBe(true);
      expect(result.reason).toContain('assuming CPU mode');
      expect(result.reason).not.toContain('Apple Silicon');
    });
  });

  describe('ReadinessProbeResult型', () => {
    it('結果オブジェクトが正しい構造を持つ', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const probe = new OllamaReadinessProbe({ skipVramCheck: true });
      const result = await probe.check();

      // 型チェック - すべてのフィールドが存在する
      expect(typeof result.ready).toBe('boolean');
      expect(typeof result.ollamaAvailable).toBe('boolean');
      expect(typeof result.waitRetries).toBe('number');
      expect(typeof result.totalWaitMs).toBe('number');
      // vram は null | VramInfo
      expect(result.vram === null || typeof result.vram === 'object').toBe(true);
    });
  });
});
