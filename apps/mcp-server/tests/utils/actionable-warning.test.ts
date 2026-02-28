// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * アクショナブル警告メッセージ テスト
 * TDD Red フェーズ: 警告メッセージをアクショナブルな形式に変換
 *
 * 警告メッセージの要件:
 * - 問題: 何が問題か
 * - 影響: なぜ問題か
 * - 推奨アクション: どう対処すべきか
 * - 参照: ドキュメントやリソースへのリンク
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type {
  ActionableWarning} from '../../src/utils/actionable-warning';
import {
  ActionableWarningCode,
  WarningFactory,
  createWarning,
  formatWarningMessage,
  setWarningLocale,
  getWarningLocale,
  WARNING_CODES,
  WARNING_SEVERITY,
  legacyWarningToActionable,
  type WarningSeverity,
} from '../../src/utils/actionable-warning';

// =============================================================================
// 共通テストヘルパー
// =============================================================================

const resetLocale = () => setWarningLocale('en');

// =============================================================================
// テストケース定義
// =============================================================================

describe('Actionable Warning Utility', () => {
  afterEach(resetLocale);

  describe('ActionableWarning インターフェース', () => {
    it('ActionableWarningが正しい構造を持つこと', () => {
      const warning: ActionableWarning = {
        type: 'warning',
        code: 'LAYOUT_TIMEOUT',
        severity: 'warning',
        message: 'レイアウト分析がタイムアウトしました',
        impact: 'セクション検出が不完全な可能性があります',
        action: 'layoutTimeoutを延長するか、URLの読み込み速度を確認してください',
        docs: 'https://reftrix.dev/docs/troubleshooting#layout-timeout',
      };

      expect(warning).toMatchObject({
        type: 'warning',
        code: 'LAYOUT_TIMEOUT',
        severity: 'warning',
        message: expect.any(String),
        impact: expect.any(String),
        action: expect.any(String),
        docs: expect.any(String),
      });
    });

    it('docsとcontextはオプショナルであること', () => {
      const warning: ActionableWarning = {
        type: 'warning',
        code: 'MOTION_DETECTION_PARTIAL',
        severity: 'info',
        message: 'モーション検出が部分的に完了しました',
        impact: 'CSS静的解析のみで結果が返されます',
        action: 'JSアニメーション検出を有効にするには detect_js_animations=true を設定',
      };

      expect(warning.docs).toBeUndefined();
      expect(warning.context).toBeUndefined();
    });

    it('contextに詳細情報を含められること', () => {
      const warning: ActionableWarning = {
        type: 'warning',
        code: 'VISION_AI_UNAVAILABLE',
        severity: 'warning',
        message: 'Vision AIサービスが利用できません',
        impact: 'Visual feature抽出がスキップされます',
        action: 'Ollamaサービスが起動しているか確認してください',
        context: {
          service: 'ollama',
          endpoint: 'http://localhost:11434',
          lastAttempt: '2026-01-24T10:00:00Z',
        },
      };

      expect(warning.context).toBeDefined();
      expect(warning.context?.service).toBe('ollama');
    });
  });

  describe('WARNING_CODES 定数', () => {
    it('必要なエラーコードが定義されていること', () => {
      // Layout related
      expect(WARNING_CODES.LAYOUT_TIMEOUT).toBe('LAYOUT_TIMEOUT');
      expect(WARNING_CODES.LAYOUT_PARTIAL).toBe('LAYOUT_PARTIAL');
      expect(WARNING_CODES.CSS_FRAMEWORK_UNKNOWN).toBe('CSS_FRAMEWORK_UNKNOWN');

      // Motion related
      expect(WARNING_CODES.MOTION_TIMEOUT).toBe('MOTION_TIMEOUT');
      expect(WARNING_CODES.MOTION_DETECTION_PARTIAL).toBe('MOTION_DETECTION_PARTIAL');
      expect(WARNING_CODES.JS_ANIMATION_SKIPPED).toBe('JS_ANIMATION_SKIPPED');
      expect(WARNING_CODES.WEBGL_ANIMATION_SKIPPED).toBe('WEBGL_ANIMATION_SKIPPED');
      expect(WARNING_CODES.FRAME_CAPTURE_FAILED).toBe('FRAME_CAPTURE_FAILED');

      // Quality related
      expect(WARNING_CODES.QUALITY_TIMEOUT).toBe('QUALITY_TIMEOUT');
      expect(WARNING_CODES.QUALITY_EVALUATION_PARTIAL).toBe('QUALITY_EVALUATION_PARTIAL');

      // Vision related
      expect(WARNING_CODES.VISION_AI_UNAVAILABLE).toBe('VISION_AI_UNAVAILABLE');
      expect(WARNING_CODES.VISION_ANALYSIS_FAILED).toBe('VISION_ANALYSIS_FAILED');
      expect(WARNING_CODES.MOOD_FALLBACK_USED).toBe('MOOD_FALLBACK_USED');
      expect(WARNING_CODES.BRAND_TONE_FALLBACK_USED).toBe('BRAND_TONE_FALLBACK_USED');

      // Network/Browser related
      expect(WARNING_CODES.NETWORK_SLOW).toBe('NETWORK_SLOW');
      expect(WARNING_CODES.BROWSER_RESOURCE_LIMIT).toBe('BROWSER_RESOURCE_LIMIT');
      expect(WARNING_CODES.EXTERNAL_CSS_FETCH_FAILED).toBe('EXTERNAL_CSS_FETCH_FAILED');

      // Performance related
      expect(WARNING_CODES.RESPONSE_SIZE_LARGE).toBe('RESPONSE_SIZE_LARGE');
      expect(WARNING_CODES.PROCESSING_TIME_EXCEEDED).toBe('PROCESSING_TIME_EXCEEDED');
    });
  });

  describe('WARNING_SEVERITY 定数', () => {
    it('重大度レベルが定義されていること', () => {
      expect(WARNING_SEVERITY.INFO).toBe('info');
      expect(WARNING_SEVERITY.WARNING).toBe('warning');
      expect(WARNING_SEVERITY.ERROR).toBe('error');
    });
  });

  describe('createWarning 関数', () => {
    it('LAYOUT_TIMEOUT 警告を生成できること', () => {
      const warning = createWarning('LAYOUT_TIMEOUT', {
        actualTimeMs: 35000,
        configuredTimeoutMs: 30000,
      });

      expect(warning.code).toBe('LAYOUT_TIMEOUT');
      expect(warning.severity).toBe('warning');
      // "timed out" or "timeout" in message
      expect(warning.message.toLowerCase()).toMatch(/time(d\s)?out/i);
      expect(warning.impact).toBeDefined();
      expect(warning.action).toBeDefined();
      expect(warning.docs).toContain('reftrix');
    });

    it('MOTION_TIMEOUT 警告を生成できること', () => {
      const warning = createWarning('MOTION_TIMEOUT', {
        actualTimeMs: 125000,
        configuredTimeoutMs: 120000,
      });

      expect(warning.code).toBe('MOTION_TIMEOUT');
      expect(warning.severity).toBe('warning');
      expect(warning.action).toContain('motionTimeout');
    });

    it('QUALITY_TIMEOUT 警告を生成できること', () => {
      const warning = createWarning('QUALITY_TIMEOUT', {
        actualTimeMs: 20000,
        configuredTimeoutMs: 15000,
      });

      expect(warning.code).toBe('QUALITY_TIMEOUT');
      expect(warning.severity).toBe('warning');
    });

    it('VISION_AI_UNAVAILABLE 警告を生成できること', () => {
      const warning = createWarning('VISION_AI_UNAVAILABLE', {
        service: 'ollama',
        reason: 'Connection refused',
      });

      expect(warning.code).toBe('VISION_AI_UNAVAILABLE');
      expect(warning.severity).toBe('warning');
      expect(warning.action).toContain('Ollama');
    });

    it('JS_ANIMATION_SKIPPED 警告を生成できること', () => {
      const warning = createWarning('JS_ANIMATION_SKIPPED', {
        reason: 'Playwright not installed',
      });

      expect(warning.code).toBe('JS_ANIMATION_SKIPPED');
      expect(warning.severity).toBe('info');
      expect(warning.action).toContain('detect_js_animations');
    });

    it('WEBGL_ANIMATION_SKIPPED 警告を生成できること', () => {
      const warning = createWarning('WEBGL_ANIMATION_SKIPPED', {
        reason: 'Canvas element not found',
      });

      expect(warning.code).toBe('WEBGL_ANIMATION_SKIPPED');
      expect(warning.severity).toBe('info');
    });

    it('EXTERNAL_CSS_FETCH_FAILED 警告を生成できること', () => {
      const warning = createWarning('EXTERNAL_CSS_FETCH_FAILED', {
        failedUrls: ['https://example.com/styles.css', 'https://example.com/theme.css'],
        failedCount: 2,
        totalCount: 5,
      });

      expect(warning.code).toBe('EXTERNAL_CSS_FETCH_FAILED');
      expect(warning.severity).toBe('warning');
      expect(warning.context?.failedCount).toBe(2);
      expect(warning.context?.totalCount).toBe(5);
    });

    it('RESPONSE_SIZE_LARGE 警告を生成できること', () => {
      const warning = createWarning('RESPONSE_SIZE_LARGE', {
        actualSizeKB: 512,
        recommendedMaxKB: 256,
      });

      expect(warning.code).toBe('RESPONSE_SIZE_LARGE');
      expect(warning.severity).toBe('info');
      expect(warning.action).toContain('summary');
    });

    it('コンテキスト情報が警告に含まれること', () => {
      const warning = createWarning('LAYOUT_TIMEOUT', {
        actualTimeMs: 35000,
        configuredTimeoutMs: 30000,
        url: 'https://example.com',
        phase: 'sectionDetection',
      });

      expect(warning.context?.actualTimeMs).toBe(35000);
      expect(warning.context?.configuredTimeoutMs).toBe(30000);
      expect(warning.context?.url).toBe('https://example.com');
    });
  });

  describe('WarningFactory クラス', () => {
    it('layoutTimeout 警告を生成できること', () => {
      const warning = WarningFactory.layoutTimeout(35000, 30000);

      expect(warning.code).toBe('LAYOUT_TIMEOUT');
      expect(warning.context?.actualTimeMs).toBe(35000);
    });

    it('motionTimeout 警告を生成できること', () => {
      const warning = WarningFactory.motionTimeout(125000, 120000);

      expect(warning.code).toBe('MOTION_TIMEOUT');
      expect(warning.context?.actualTimeMs).toBe(125000);
    });

    it('qualityTimeout 警告を生成できること', () => {
      const warning = WarningFactory.qualityTimeout(20000, 15000);

      expect(warning.code).toBe('QUALITY_TIMEOUT');
    });

    it('visionUnavailable 警告を生成できること', () => {
      const warning = WarningFactory.visionUnavailable('ollama', 'Connection refused');

      expect(warning.code).toBe('VISION_AI_UNAVAILABLE');
      expect(warning.context?.service).toBe('ollama');
    });

    it('jsAnimationSkipped 警告を生成できること', () => {
      const warning = WarningFactory.jsAnimationSkipped('Playwright not available');

      expect(warning.code).toBe('JS_ANIMATION_SKIPPED');
    });

    it('webglAnimationSkipped 警告を生成できること', () => {
      const warning = WarningFactory.webglAnimationSkipped('No canvas detected');

      expect(warning.code).toBe('WEBGL_ANIMATION_SKIPPED');
    });

    it('externalCssFetchFailed 警告を生成できること', () => {
      const failedUrls = ['https://example.com/a.css', 'https://example.com/b.css'];
      const warning = WarningFactory.externalCssFetchFailed(failedUrls, 2, 10);

      expect(warning.code).toBe('EXTERNAL_CSS_FETCH_FAILED');
      expect(warning.context?.failedCount).toBe(2);
      expect(warning.context?.totalCount).toBe(10);
    });

    it('responseSizeLarge 警告を生成できること', () => {
      const warning = WarningFactory.responseSizeLarge(512, 256);

      expect(warning.code).toBe('RESPONSE_SIZE_LARGE');
      expect(warning.context?.actualSizeKB).toBe(512);
    });

    it('frameCaptureFailedを生成できること', () => {
      const warning = WarningFactory.frameCaptureFailed('Memory limit exceeded', 1000);

      expect(warning.code).toBe('FRAME_CAPTURE_FAILED');
      expect(warning.context?.framesAttempted).toBe(1000);
    });

    it('moodFallbackUsed 警告を生成できること', () => {
      const warning = WarningFactory.moodFallbackUsed('Low confidence');

      expect(warning.code).toBe('MOOD_FALLBACK_USED');
      expect(warning.severity).toBe('info');
    });

    it('brandToneFallbackUsed 警告を生成できること', () => {
      const warning = WarningFactory.brandToneFallbackUsed('Parse error');

      expect(warning.code).toBe('BRAND_TONE_FALLBACK_USED');
      expect(warning.severity).toBe('info');
    });
  });

  describe('formatWarningMessage 関数', () => {
    it('警告を人間が読みやすい形式にフォーマットできること', () => {
      const warning = createWarning('LAYOUT_TIMEOUT', {
        actualTimeMs: 35000,
        configuredTimeoutMs: 30000,
      });

      const formatted = formatWarningMessage(warning);

      expect(formatted).toContain('LAYOUT_TIMEOUT');
      expect(formatted).toContain(warning.message);
      expect(formatted).toContain(warning.action);
    });

    it('複数の警告をまとめてフォーマットできること', () => {
      const warnings: ActionableWarning[] = [
        createWarning('LAYOUT_TIMEOUT', { actualTimeMs: 35000, configuredTimeoutMs: 30000 }),
        createWarning('VISION_AI_UNAVAILABLE', { service: 'ollama', reason: 'Not running' }),
      ];

      const formatted = formatWarningMessage(warnings);

      expect(formatted).toContain('LAYOUT_TIMEOUT');
      expect(formatted).toContain('VISION_AI_UNAVAILABLE');
    });

    it('JSON形式でフォーマットできること', () => {
      const warning = createWarning('LAYOUT_TIMEOUT', {
        actualTimeMs: 35000,
        configuredTimeoutMs: 30000,
      });

      const formatted = formatWarningMessage(warning, { format: 'json' });
      const parsed = JSON.parse(formatted);

      expect(parsed.code).toBe('LAYOUT_TIMEOUT');
      expect(parsed.message).toBeDefined();
      expect(parsed.action).toBeDefined();
    });

    it('簡易形式でフォーマットできること', () => {
      const warning = createWarning('LAYOUT_TIMEOUT', {
        actualTimeMs: 35000,
        configuredTimeoutMs: 30000,
      });

      const formatted = formatWarningMessage(warning, { format: 'compact' });

      expect(formatted).toContain('[LAYOUT_TIMEOUT]');
      expect(formatted.length).toBeLessThan(500);
    });
  });

  describe('ロケール対応', () => {
    beforeEach(resetLocale);

    it('デフォルトは英語であること', () => {
      expect(getWarningLocale()).toBe('en');
    });

    it('日本語に切り替えられること', () => {
      setWarningLocale('ja');
      expect(getWarningLocale()).toBe('ja');

      const warning = createWarning('LAYOUT_TIMEOUT', {
        actualTimeMs: 35000,
        configuredTimeoutMs: 30000,
      });

      // 日本語メッセージを確認
      expect(warning.message).toContain('タイムアウト');
    });

    it('英語に切り替えられること', () => {
      setWarningLocale('ja');
      setWarningLocale('en');
      expect(getWarningLocale()).toBe('en');

      const warning = createWarning('LAYOUT_TIMEOUT', {
        actualTimeMs: 35000,
        configuredTimeoutMs: 30000,
      });

      // "timed out" or "timeout" in message
      expect(warning.message.toLowerCase()).toMatch(/time(d\s)?out/i);
    });
  });

  describe('警告の重大度', () => {
    it('タイムアウト警告は warning レベルであること', () => {
      const warning = createWarning('LAYOUT_TIMEOUT', {
        actualTimeMs: 35000,
        configuredTimeoutMs: 30000,
      });

      expect(warning.severity).toBe('warning');
    });

    it('スキップ警告は info レベルであること', () => {
      const warning = createWarning('JS_ANIMATION_SKIPPED', {
        reason: 'Not enabled',
      });

      expect(warning.severity).toBe('info');
    });

    it('フォールバック警告は info レベルであること', () => {
      const warning = createWarning('MOOD_FALLBACK_USED', {
        reason: 'Low confidence',
      });

      expect(warning.severity).toBe('info');
    });

    it('サービス利用不可警告は warning レベルであること', () => {
      const warning = createWarning('VISION_AI_UNAVAILABLE', {
        service: 'ollama',
        reason: 'Not running',
      });

      expect(warning.severity).toBe('warning');
    });
  });

  describe('ドキュメントリンク', () => {
    it('タイムアウト警告にトラブルシューティングリンクが含まれること', () => {
      const warning = createWarning('LAYOUT_TIMEOUT', {
        actualTimeMs: 35000,
        configuredTimeoutMs: 30000,
      });

      expect(warning.docs).toContain('reftrix.dev');
      expect(warning.docs).toContain('troubleshooting');
    });

    it('Vision警告にセットアップリンクが含まれること', () => {
      const warning = createWarning('VISION_AI_UNAVAILABLE', {
        service: 'ollama',
        reason: 'Not running',
      });

      expect(warning.docs).toContain('reftrix.dev');
      expect(warning.docs).toContain('vision');
    });
  });

  describe('後方互換性', () => {
    it('legacyWarningToActionable で旧形式を変換できること', () => {
      const legacyWarning = {
        feature: 'layout' as const,
        code: 'TIMEOUT_ERROR',
        message: 'Layout analysis timed out',
      };

      const actionable = legacyWarningToActionable(legacyWarning);

      expect(actionable.type).toBe('warning');
      expect(actionable.code).toBeDefined();
      expect(actionable.message).toBeDefined();
      expect(actionable.action).toBeDefined();
    });
  });
});
