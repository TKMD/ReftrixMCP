// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * result-builder.ts アクショナブル警告統合テスト
 *
 * @module tests/tools/page/result-builder-actionable.test
 */

import { describe, it, expect } from 'vitest';
import {
  extractActionableWarning,
  extractAllActionableWarnings,
} from '../../../src/tools/page/handlers/result-builder';
import { PAGE_ANALYZE_ERROR_CODES } from '../../../src/tools/page/schemas';

describe('extractActionableWarning', () => {
  describe('タイムアウトエラー検出', () => {
    it('TIMEOUT_ERRORコードでアクショナブル警告を生成', () => {
      const result = {
        success: false,
        error: {
          code: PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR,
          message: 'Operation timed out after 60000ms',
        },
      };

      const warning = extractActionableWarning('layout', result, {
        url: 'https://example.com',
        timeoutMs: 60000,
      });

      expect(warning).not.toBeNull();
      expect(warning?.code).toBe('PAGE_TIMEOUT');
      expect(warning?.severity).toBe('error');
      expect(warning?.action).toContain('timeout');
      expect(warning?.context?.url).toBe('https://example.com');
    });

    it('メッセージ内の "timeout" キーワードで検出', () => {
      const result = {
        success: false,
        error: {
          code: 'UNKNOWN_ERROR',
          message: 'Request timeout exceeded',
        },
      };

      const warning = extractActionableWarning('motion', result);

      expect(warning).not.toBeNull();
      expect(warning?.code).toBe('PAGE_TIMEOUT');
    });

    it('メッセージ内の "timed out" キーワードで検出', () => {
      const result = {
        success: false,
        error: {
          code: 'UNKNOWN_ERROR',
          message: 'Navigation timed out waiting for load',
        },
      };

      const warning = extractActionableWarning('quality', result);

      expect(warning).not.toBeNull();
      expect(warning?.code).toBe('PAGE_TIMEOUT');
    });
  });

  describe('ネットワークエラー検出', () => {
    it('NETWORK_ERRORコードでアクショナブル警告を生成', () => {
      const result = {
        success: false,
        error: {
          code: PAGE_ANALYZE_ERROR_CODES.NETWORK_ERROR,
          message: 'Failed to fetch page',
        },
      };

      const warning = extractActionableWarning('layout', result, {
        url: 'https://example.com',
      });

      expect(warning).not.toBeNull();
      expect(warning?.code).toBe('NETWORK_ERROR');
      expect(warning?.severity).toBe('error');
    });

    it('メッセージ内の "ECONNREFUSED" で検出', () => {
      const result = {
        success: false,
        error: {
          code: 'UNKNOWN_ERROR',
          message: 'connect ECONNREFUSED 127.0.0.1:3000',
        },
      };

      const warning = extractActionableWarning('layout', result);

      expect(warning).not.toBeNull();
      expect(warning?.code).toBe('NETWORK_ERROR');
    });
  });

  describe('HTTPエラー検出', () => {
    it('HTTP_ERRORコードでアクショナブル警告を生成', () => {
      const result = {
        success: false,
        error: {
          code: PAGE_ANALYZE_ERROR_CODES.HTTP_ERROR,
          message: 'HTTP 404 Not Found',
        },
      };

      const warning = extractActionableWarning('layout', result, {
        url: 'https://example.com/missing',
      });

      expect(warning).not.toBeNull();
      expect(warning?.code).toBe('HTTP_ERROR');
      expect(warning?.context?.statusCode).toBe(404);
    });

    it('メッセージ内のステータスコードを抽出', () => {
      const result = {
        success: false,
        error: {
          code: 'UNKNOWN_ERROR',
          message: 'Server returned 500 Internal Server Error',
        },
      };

      const warning = extractActionableWarning('layout', result);

      expect(warning).not.toBeNull();
      expect(warning?.code).toBe('HTTP_ERROR');
      expect(warning?.context?.statusCode).toBe(500);
    });
  });

  describe('ブラウザエラー検出', () => {
    it('BROWSER_ERRORコードでアクショナブル警告を生成', () => {
      const result = {
        success: false,
        error: {
          code: PAGE_ANALYZE_ERROR_CODES.BROWSER_ERROR,
          message: 'Browser crashed during navigation',
        },
      };

      const warning = extractActionableWarning('layout', result);

      expect(warning).not.toBeNull();
      expect(warning?.code).toBe('BROWSER_ERROR');
    });

    it('メッセージ内の "Playwright" で検出', () => {
      const result = {
        success: false,
        error: {
          code: 'UNKNOWN_ERROR',
          message: 'Playwright browser context closed unexpectedly',
        },
      };

      const warning = extractActionableWarning('layout', result);

      expect(warning).not.toBeNull();
      expect(warning?.code).toBe('BROWSER_ERROR');
    });
  });

  describe('Vision分析エラー検出', () => {
    it('Vision unavailable メッセージで検出', () => {
      const result = {
        success: false,
        error: {
          code: 'VISION_ERROR',
          message: 'Vision analysis unavailable: Ollama not running',
        },
      };

      const warning = extractActionableWarning('layout', result);

      expect(warning).not.toBeNull();
      expect(warning?.code).toBe('VISION_UNAVAILABLE');
      expect(warning?.severity).toBe('warning');
    });
  });

  describe('レイアウト固有エラー', () => {
    it('セクション未検出警告を生成', () => {
      const result = {
        success: false,
        error: {
          code: 'LAYOUT_ERROR',
          message: 'No sections detected in the page',
        },
      };

      const warning = extractActionableWarning('layout', result, {
        url: 'https://example.com',
      });

      expect(warning).not.toBeNull();
      expect(warning?.code).toBe('NO_SECTIONS_DETECTED');
      expect(warning?.severity).toBe('warning');
    });
  });

  describe('モーション固有エラー', () => {
    it('アニメーション未検出警告を生成', () => {
      const result = {
        success: false,
        error: {
          code: 'MOTION_ERROR',
          message: 'No animations detected on the page',
        },
      };

      const warning = extractActionableWarning('motion', result, {
        url: 'https://example.com',
      });

      expect(warning).not.toBeNull();
      expect(warning?.code).toBe('NO_ANIMATIONS_DETECTED');
      expect(warning?.severity).toBe('info');
    });
  });

  describe('品質評価固有エラー', () => {
    it('低スコア警告を生成', () => {
      const result = {
        success: false,
        error: {
          code: 'QUALITY_ERROR',
          message: 'Quality evaluation found low score',
        },
      };

      const warning = extractActionableWarning('quality', result);

      expect(warning).not.toBeNull();
      expect(warning?.code).toBe('LOW_QUALITY_SCORE');
      expect(warning?.severity).toBe('warning');
    });
  });

  describe('フォールバック変換', () => {
    it('未知のエラーコードでfeatureに基づいたフォールバック変換', () => {
      const result = {
        success: false,
        error: {
          code: 'CUSTOM_UNKNOWN_ERROR',
          message: 'Something unexpected happened',
        },
      };

      // layout featureの場合、LAYOUT_PARTIALにフォールバック
      const layoutWarning = extractActionableWarning('layout', result);
      expect(layoutWarning).not.toBeNull();
      expect(layoutWarning?.code).toBe('LAYOUT_PARTIAL');
      // テンプレートメッセージまたはオリジナルメッセージ（長い方）が使用される
      expect(layoutWarning?.message).toBeTruthy();
      expect(layoutWarning?.severity).toBe('warning');
      // コンテキストにレガシーメッセージが保存される
      expect(layoutWarning?.context?.legacyMessage).toBe('Something unexpected happened');

      // motion featureの場合、MOTION_DETECTION_PARTIALにフォールバック
      const motionWarning = extractActionableWarning('motion', result);
      expect(motionWarning).not.toBeNull();
      expect(motionWarning?.code).toBe('MOTION_DETECTION_PARTIAL');

      // quality featureの場合、QUALITY_EVALUATION_PARTIALにフォールバック
      const qualityWarning = extractActionableWarning('quality', result);
      expect(qualityWarning).not.toBeNull();
      expect(qualityWarning?.code).toBe('QUALITY_EVALUATION_PARTIAL');
    });
  });

  describe('成功時', () => {
    it('成功結果ではnullを返す', () => {
      const result = {
        success: true,
      };

      const warning = extractActionableWarning('layout', result);

      expect(warning).toBeNull();
    });
  });
});

describe('extractAllActionableWarnings', () => {
  it('複数の分析結果から警告を収集', () => {
    const results = {
      layout: {
        success: false,
        error: {
          code: PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR,
          message: 'Layout analysis timed out',
        },
      },
      motion: {
        success: true,
      },
      quality: {
        success: false,
        error: {
          code: PAGE_ANALYZE_ERROR_CODES.NETWORK_ERROR,
          message: 'Quality service unavailable',
        },
      },
    };

    const warnings = extractAllActionableWarnings(results, {
      url: 'https://example.com',
    });

    expect(warnings).toHaveLength(2);
    expect(warnings[0].code).toBe('PAGE_TIMEOUT');
    expect(warnings[1].code).toBe('NETWORK_ERROR');
  });

  it('すべて成功の場合は空配列', () => {
    const results = {
      layout: { success: true },
      motion: { success: true },
      quality: { success: true },
    };

    const warnings = extractAllActionableWarnings(results);

    expect(warnings).toHaveLength(0);
  });

  it('一部の分析結果が欠落していても動作', () => {
    const results = {
      layout: {
        success: false,
        error: {
          code: 'ERROR',
          message: 'Failed',
        },
      },
      // motion と quality は省略
    };

    const warnings = extractAllActionableWarnings(results);

    expect(warnings).toHaveLength(1);
  });
});
