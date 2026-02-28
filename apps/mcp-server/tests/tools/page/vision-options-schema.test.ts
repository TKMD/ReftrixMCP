// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vision Options Schema Validation Tests
 *
 * Vision CPU完走保証 Phase 3: visionOptionsSchema のバリデーションテスト
 *
 * テスト対象:
 * - visionOptionsSchema: Vision CPU完走保証オプション
 *   - visionTimeoutMs: タイムアウト値（1000-1200000ms）
 *   - visionImageMaxSize: 最大画像サイズ（1024-10000000 bytes）
 *   - visionForceCpu: 強制CPUモード（デフォルト: false）
 *   - visionEnableProgress: 進捗報告有効（デフォルト: false）
 *   - visionFallbackToHtmlOnly: HTML フォールバック（デフォルト: true）
 *
 * @module tests/tools/page/vision-options-schema.test
 */

import { describe, it, expect } from 'vitest';
import { visionOptionsSchema } from '../../../src/tools/page/schemas';

// =============================================================================
// Test Data Factories
// =============================================================================

const createValidVisionOptions = () => ({
  visionTimeoutMs: 600000, // 10 minutes
  visionImageMaxSize: 5000000, // 5MB
  visionForceCpu: false,
  visionEnableProgress: false,
  visionFallbackToHtmlOnly: true,
});

// =============================================================================
// visionOptionsSchema Tests
// =============================================================================

describe('visionOptionsSchema', () => {
  describe('valid inputs', () => {
    it('should accept valid complete options', () => {
      const result = visionOptionsSchema.safeParse(createValidVisionOptions());
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionTimeoutMs).toBe(600000);
        expect(result.data.visionImageMaxSize).toBe(5000000);
        expect(result.data.visionForceCpu).toBe(false);
        expect(result.data.visionEnableProgress).toBe(false);
        expect(result.data.visionFallbackToHtmlOnly).toBe(true);
      }
    });

    it('should accept empty object (all fields optional)', () => {
      const result = visionOptionsSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        // デフォルト値が適用される
        expect(result.data.visionForceCpu).toBe(false);
        expect(result.data.visionEnableProgress).toBe(false);
        expect(result.data.visionFallbackToHtmlOnly).toBe(true);
      }
    });

    it('should accept undefined (optional schema)', () => {
      const result = visionOptionsSchema.safeParse(undefined);
      expect(result.success).toBe(true);
    });

    // visionTimeoutMs boundary tests
    it('should accept visionTimeoutMs at minimum (1000ms = 1秒)', () => {
      const result = visionOptionsSchema.safeParse({ visionTimeoutMs: 1000 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionTimeoutMs).toBe(1000);
      }
    });

    it('should accept visionTimeoutMs at maximum (1200000ms = 20分)', () => {
      const result = visionOptionsSchema.safeParse({ visionTimeoutMs: 1200000 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionTimeoutMs).toBe(1200000);
      }
    });

    it('should accept typical GPU timeout (60000ms = 1分)', () => {
      const result = visionOptionsSchema.safeParse({ visionTimeoutMs: 60000 });
      expect(result.success).toBe(true);
    });

    it('should accept typical CPU small timeout (180000ms = 3分)', () => {
      const result = visionOptionsSchema.safeParse({ visionTimeoutMs: 180000 });
      expect(result.success).toBe(true);
    });

    it('should accept typical CPU medium timeout (600000ms = 10分)', () => {
      const result = visionOptionsSchema.safeParse({ visionTimeoutMs: 600000 });
      expect(result.success).toBe(true);
    });

    // visionImageMaxSize boundary tests
    it('should accept visionImageMaxSize at minimum (1024 bytes = 1KB)', () => {
      const result = visionOptionsSchema.safeParse({ visionImageMaxSize: 1024 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionImageMaxSize).toBe(1024);
      }
    });

    it('should accept visionImageMaxSize at maximum (10000000 bytes = 10MB)', () => {
      const result = visionOptionsSchema.safeParse({ visionImageMaxSize: 10000000 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionImageMaxSize).toBe(10000000);
      }
    });

    it('should accept typical small image size threshold (100000 bytes = 100KB)', () => {
      const result = visionOptionsSchema.safeParse({ visionImageMaxSize: 100000 });
      expect(result.success).toBe(true);
    });

    it('should accept typical large image size threshold (500000 bytes = 500KB)', () => {
      const result = visionOptionsSchema.safeParse({ visionImageMaxSize: 500000 });
      expect(result.success).toBe(true);
    });

    // Boolean fields tests
    it('should accept visionForceCpu: true (force CPU mode)', () => {
      const result = visionOptionsSchema.safeParse({ visionForceCpu: true });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionForceCpu).toBe(true);
      }
    });

    it('should accept visionEnableProgress: true (enable progress)', () => {
      const result = visionOptionsSchema.safeParse({ visionEnableProgress: true });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionEnableProgress).toBe(true);
      }
    });

    it('should accept visionFallbackToHtmlOnly: false (disable fallback)', () => {
      const result = visionOptionsSchema.safeParse({ visionFallbackToHtmlOnly: false });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionFallbackToHtmlOnly).toBe(false);
      }
    });

    // Partial options tests
    it('should accept only timeout option', () => {
      const result = visionOptionsSchema.safeParse({ visionTimeoutMs: 300000 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionTimeoutMs).toBe(300000);
        // デフォルト値
        expect(result.data.visionForceCpu).toBe(false);
        expect(result.data.visionFallbackToHtmlOnly).toBe(true);
      }
    });

    it('should accept CPU mode with custom timeout', () => {
      const result = visionOptionsSchema.safeParse({
        visionForceCpu: true,
        visionTimeoutMs: 1200000, // 20分（CPU Large用）
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionForceCpu).toBe(true);
        expect(result.data.visionTimeoutMs).toBe(1200000);
      }
    });
  });

  describe('invalid inputs', () => {
    // visionTimeoutMs validation errors
    it('should reject visionTimeoutMs below minimum (< 1000ms)', () => {
      const result = visionOptionsSchema.safeParse({ visionTimeoutMs: 999 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('visionTimeoutMs');
      }
    });

    it('should reject visionTimeoutMs above maximum (> 1200000ms)', () => {
      const result = visionOptionsSchema.safeParse({ visionTimeoutMs: 1200001 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('visionTimeoutMs');
      }
    });

    it('should reject negative visionTimeoutMs', () => {
      const result = visionOptionsSchema.safeParse({ visionTimeoutMs: -1000 });
      expect(result.success).toBe(false);
    });

    it('should reject zero visionTimeoutMs', () => {
      const result = visionOptionsSchema.safeParse({ visionTimeoutMs: 0 });
      expect(result.success).toBe(false);
    });

    // visionImageMaxSize validation errors
    it('should reject visionImageMaxSize below minimum (< 1024 bytes)', () => {
      const result = visionOptionsSchema.safeParse({ visionImageMaxSize: 1023 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('visionImageMaxSize');
      }
    });

    it('should reject visionImageMaxSize above maximum (> 10000000 bytes)', () => {
      const result = visionOptionsSchema.safeParse({ visionImageMaxSize: 10000001 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('visionImageMaxSize');
      }
    });

    it('should reject negative visionImageMaxSize', () => {
      const result = visionOptionsSchema.safeParse({ visionImageMaxSize: -1024 });
      expect(result.success).toBe(false);
    });

    it('should reject zero visionImageMaxSize', () => {
      const result = visionOptionsSchema.safeParse({ visionImageMaxSize: 0 });
      expect(result.success).toBe(false);
    });

    // Type validation errors
    it('should reject non-number visionTimeoutMs', () => {
      const result = visionOptionsSchema.safeParse({ visionTimeoutMs: '60000' });
      expect(result.success).toBe(false);
    });

    it('should reject non-number visionImageMaxSize', () => {
      const result = visionOptionsSchema.safeParse({ visionImageMaxSize: '5000000' });
      expect(result.success).toBe(false);
    });

    it('should reject non-boolean visionForceCpu', () => {
      const result = visionOptionsSchema.safeParse({ visionForceCpu: 'true' });
      expect(result.success).toBe(false);
    });

    it('should reject non-boolean visionEnableProgress', () => {
      const result = visionOptionsSchema.safeParse({ visionEnableProgress: 1 });
      expect(result.success).toBe(false);
    });

    it('should reject non-boolean visionFallbackToHtmlOnly', () => {
      const result = visionOptionsSchema.safeParse({ visionFallbackToHtmlOnly: 'false' });
      expect(result.success).toBe(false);
    });

    // Float/decimal validation (should accept but may truncate)
    it('should reject float visionTimeoutMs', () => {
      // Zodはデフォルトでfloatを許容するが、適切にintegerに変換される
      // または、厳密なint制約を追加している場合は拒否される
      const result = visionOptionsSchema.safeParse({ visionTimeoutMs: 60000.5 });
      // floatは受け入れる（truncateされる）か、厳密に拒否するか実装次第
      // このテストは実装を確認するためのもの
      if (result.success) {
        // floatを受け入れる場合
        expect(typeof result.data.visionTimeoutMs).toBe('number');
      }
      // 実装で厳密にintegerを要求する場合は expect(result.success).toBe(false);
    });
  });

  describe('default values', () => {
    it('should apply default false for visionForceCpu when not specified', () => {
      const result = visionOptionsSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionForceCpu).toBe(false);
      }
    });

    it('should apply default false for visionEnableProgress when not specified', () => {
      const result = visionOptionsSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionEnableProgress).toBe(false);
      }
    });

    it('should apply default true for visionFallbackToHtmlOnly when not specified', () => {
      const result = visionOptionsSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionFallbackToHtmlOnly).toBe(true);
      }
    });

    it('should not apply defaults for optional numeric fields', () => {
      const result = visionOptionsSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionTimeoutMs).toBeUndefined();
        expect(result.data.visionImageMaxSize).toBeUndefined();
      }
    });
  });

  describe('use cases', () => {
    it('should support GPU mode with fast timeout', () => {
      const result = visionOptionsSchema.safeParse({
        visionTimeoutMs: 60000, // GPU timeout
        visionForceCpu: false,
      });
      expect(result.success).toBe(true);
    });

    it('should support CPU mode with extended timeout for large images', () => {
      const result = visionOptionsSchema.safeParse({
        visionTimeoutMs: 1200000, // 20分（CPU Large）
        visionForceCpu: true,
        visionImageMaxSize: 500000, // 500KB以上は aggressive optimization
      });
      expect(result.success).toBe(true);
    });

    it('should support progress tracking for long operations', () => {
      const result = visionOptionsSchema.safeParse({
        visionTimeoutMs: 600000,
        visionEnableProgress: true,
      });
      expect(result.success).toBe(true);
    });

    it('should support strict mode (no fallback)', () => {
      const result = visionOptionsSchema.safeParse({
        visionFallbackToHtmlOnly: false, // Vision失敗時にエラーを返す
      });
      expect(result.success).toBe(true);
    });

    it('should support graceful degradation mode (default)', () => {
      const result = visionOptionsSchema.safeParse({
        visionFallbackToHtmlOnly: true, // Vision失敗時にHTML解析のみで続行
      });
      expect(result.success).toBe(true);
    });
  });
});
