// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vision CPU完走保証 Phase 4: page.analyzeタイムアウト自動延長テスト
 *
 * CPU環境でVision分析を使用する場合、page.analyzeの全体タイムアウトと
 * フェーズタイムアウトを自動的に延長する機能のテスト。
 *
 * 問題:
 * - page.analyzeのデフォルトタイムアウトは60秒
 * - distributeTimeout()でlayout phaseに割り当てられるのは約7.7秒
 * - Vision CPU処理には180秒-1200秒必要
 * - 外側のphaseタイムアウトで先にタイムアウトしてしまう
 *
 * 解決策:
 * - 早期にハードウェア検出を行う
 * - CPU環境時には全体タイムアウトを自動延長
 * - distributeTimeout()にハードウェア情報を渡す
 *
 * @module tests/unit/tools/page/handlers/vision-cpu-timeout-extension
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// loggerとisDevelopmentをモック
vi.mock('../../../../../src/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

import {
  distributeTimeout,
  type DistributeTimeoutOptions,
} from '../../../../../src/tools/page/handlers/timeout-utils';
import { VisionTimeouts, HardwareType } from '../../../../../src/services/vision/timeout-calculator';

// =============================================================================
// distributeTimeout CPU拡張テスト
// =============================================================================

describe('Vision CPU完走保証 Phase 4: distributeTimeout CPU対応', () => {
  describe('hardwareInfo パラメータ', () => {
    it('should accept hardwareInfo parameter in distributeTimeout', () => {
      // distributeTimeoutがhardwareInfo引数を受け入れることを確認
      const result = distributeTimeout(60000, false, false, undefined, {
        type: HardwareType.GPU,
        isVisionEnabled: true,
      });

      expect(result).toBeDefined();
      expect(result.layoutAnalysis).toBeGreaterThan(0);
    });

    it('should not extend timeout for GPU environment', () => {
      const gpuResult = distributeTimeout(60000, false, false, undefined, {
        type: HardwareType.GPU,
        isVisionEnabled: true,
      });

      const noHardwareResult = distributeTimeout(60000, false, false);

      // GPU環境では延長なし
      expect(gpuResult.layoutAnalysis).toBe(noHardwareResult.layoutAnalysis);
    });

    it('should extend layoutAnalysis timeout for CPU environment with Vision enabled', () => {
      const cpuResult = distributeTimeout(60000, false, false, undefined, {
        type: HardwareType.CPU,
        isVisionEnabled: true,
      });

      // CPU環境 + Vision有効時はlayoutAnalysisタイムアウトが延長される
      // VisionTimeouts.CPU_SMALL (180秒) 以上が必要
      expect(cpuResult.layoutAnalysis).toBeGreaterThanOrEqual(VisionTimeouts.CPU_SMALL);
    });

    it('should not extend timeout for CPU environment when Vision is disabled', () => {
      const cpuNoVisionResult = distributeTimeout(60000, false, false, undefined, {
        type: HardwareType.CPU,
        isVisionEnabled: false,
      });

      const noHardwareResult = distributeTimeout(60000, false, false);

      // Vision無効時は延長なし
      expect(cpuNoVisionResult.layoutAnalysis).toBe(noHardwareResult.layoutAnalysis);
    });
  });

  describe('CPU timeout tiers', () => {
    it('should apply CPU_SMALL timeout (180s) for small images', () => {
      const result = distributeTimeout(60000, false, false, undefined, {
        type: HardwareType.CPU,
        isVisionEnabled: true,
        imageSizeBytes: 50000, // 50KB = Small
      });

      // CPU_SMALL: 180秒
      expect(result.layoutAnalysis).toBeGreaterThanOrEqual(VisionTimeouts.CPU_SMALL);
    });

    it('should apply CPU_MEDIUM timeout (600s) for medium images', () => {
      const result = distributeTimeout(60000, false, false, undefined, {
        type: HardwareType.CPU,
        isVisionEnabled: true,
        imageSizeBytes: 200000, // 200KB = Medium
      });

      // CPU_MEDIUM: 600秒
      expect(result.layoutAnalysis).toBeGreaterThanOrEqual(VisionTimeouts.CPU_MEDIUM);
    });

    it('should apply CPU_LARGE timeout (1200s) for large images', () => {
      const result = distributeTimeout(60000, false, false, undefined, {
        type: HardwareType.CPU,
        isVisionEnabled: true,
        imageSizeBytes: 600000, // 600KB = Large
      });

      // CPU_LARGE: 1200秒
      expect(result.layoutAnalysis).toBeGreaterThanOrEqual(VisionTimeouts.CPU_LARGE);
    });
  });

  describe('interaction with WebGL detection', () => {
    it('should combine CPU extension with WebGL multiplier for motion', () => {
      const result = distributeTimeout(60000, false, true, { detected: true, multiplier: 1.5 }, {
        type: HardwareType.CPU,
        isVisionEnabled: true,
      });

      // CPU拡張とWebGL乗数が両方適用される
      expect(result.layoutAnalysis).toBeGreaterThanOrEqual(VisionTimeouts.CPU_SMALL);
      // WebGL乗数はJSアニメーション有効時のみmotion検出に適用
      expect(result.motionDetection).toBeGreaterThan(30000);
    });
  });

  describe('backward compatibility', () => {
    it('should work without hardwareInfo parameter (backward compatible)', () => {
      // hardwareInfoなしでも従来通り動作する
      const result = distributeTimeout(120000, false, false);

      expect(result.layoutAnalysis).toBeGreaterThan(0);
      expect(result.motionDetection).toBeGreaterThan(0);
      expect(result.qualityEvaluation).toBeGreaterThan(0);
    });

    it('should work with undefined hardwareInfo', () => {
      const result = distributeTimeout(120000, false, false, undefined, undefined);

      expect(result.layoutAnalysis).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// calculateEffectiveTimeout 関数テスト
// =============================================================================

describe('Vision CPU完走保証 Phase 4: calculateEffectiveTimeout', () => {
  // この関数はanalyze.tool.tsに追加予定

  describe('GPU environment', () => {
    it('should not extend timeout for GPU environment', async () => {
      // GPU環境では元のタイムアウトを維持
      const { calculateEffectiveTimeout } = await import(
        '../../../../../src/tools/page/handlers/timeout-utils'
      );

      const result = calculateEffectiveTimeout({
        originalTimeout: 60000,
        hardwareType: HardwareType.GPU,
        isVisionEnabled: true,
      });

      expect(result.effectiveTimeout).toBe(60000);
      expect(result.extended).toBe(false);
    });
  });

  describe('CPU environment with Vision', () => {
    it('should extend timeout for CPU environment with Vision enabled', async () => {
      const { calculateEffectiveTimeout } = await import(
        '../../../../../src/tools/page/handlers/timeout-utils'
      );

      const result = calculateEffectiveTimeout({
        originalTimeout: 60000,
        hardwareType: HardwareType.CPU,
        isVisionEnabled: true,
      });

      // CPU環境ではタイムアウトが延長される
      expect(result.effectiveTimeout).toBeGreaterThan(60000);
      expect(result.extended).toBe(true);
      expect(result.reason).toContain('CPU');
    });

    it('should calculate timeout based on image size for CPU', async () => {
      const { calculateEffectiveTimeout } = await import(
        '../../../../../src/tools/page/handlers/timeout-utils'
      );

      const smallResult = calculateEffectiveTimeout({
        originalTimeout: 60000,
        hardwareType: HardwareType.CPU,
        isVisionEnabled: true,
        imageSizeBytes: 50000, // Small
      });

      const largeResult = calculateEffectiveTimeout({
        originalTimeout: 60000,
        hardwareType: HardwareType.CPU,
        isVisionEnabled: true,
        imageSizeBytes: 600000, // Large
      });

      // Large画像はSmall画像より長いタイムアウト
      expect(largeResult.effectiveTimeout).toBeGreaterThan(smallResult.effectiveTimeout);
    });

    it('should not exceed maximum timeout', async () => {
      const { calculateEffectiveTimeout, MAX_EXTENDED_TIMEOUT } = await import(
        '../../../../../src/tools/page/handlers/timeout-utils'
      );

      const result = calculateEffectiveTimeout({
        originalTimeout: 60000,
        hardwareType: HardwareType.CPU,
        isVisionEnabled: true,
        imageSizeBytes: 1000000, // Very large
      });

      // 最大タイムアウトを超えない
      expect(result.effectiveTimeout).toBeLessThanOrEqual(MAX_EXTENDED_TIMEOUT);
    });
  });

  describe('CPU environment without Vision', () => {
    it('should not extend timeout when Vision is disabled', async () => {
      const { calculateEffectiveTimeout } = await import(
        '../../../../../src/tools/page/handlers/timeout-utils'
      );

      const result = calculateEffectiveTimeout({
        originalTimeout: 60000,
        hardwareType: HardwareType.CPU,
        isVisionEnabled: false,
      });

      expect(result.effectiveTimeout).toBe(60000);
      expect(result.extended).toBe(false);
    });
  });

  describe('user override', () => {
    it('should respect user-specified timeout if larger than calculated', async () => {
      const { calculateEffectiveTimeout } = await import(
        '../../../../../src/tools/page/handlers/timeout-utils'
      );

      const result = calculateEffectiveTimeout({
        originalTimeout: 300000, // User specified 5 minutes
        hardwareType: HardwareType.CPU,
        isVisionEnabled: true,
        imageSizeBytes: 50000, // Small (would be 180s)
      });

      // ユーザー指定の5分が計算値(180s)より大きいので、ユーザー指定を使用
      expect(result.effectiveTimeout).toBe(300000);
      expect(result.extended).toBe(false); // ユーザー指定なので延長とは見なさない
    });

    it('should extend if calculated timeout is larger than user timeout', async () => {
      const { calculateEffectiveTimeout } = await import(
        '../../../../../src/tools/page/handlers/timeout-utils'
      );

      const result = calculateEffectiveTimeout({
        originalTimeout: 60000, // User specified 1 minute
        hardwareType: HardwareType.CPU,
        isVisionEnabled: true,
        imageSizeBytes: 600000, // Large (would be 1200s)
      });

      // 計算値(1200s)がユーザー指定(60s)より大きいので延長
      expect(result.effectiveTimeout).toBeGreaterThanOrEqual(VisionTimeouts.CPU_LARGE);
      expect(result.extended).toBe(true);
    });
  });
});

// =============================================================================
// ExecutionStatus CPU extension tracking
// =============================================================================

describe('Vision CPU完走保証 Phase 4: ExecutionStatusTracker CPU拡張', () => {
  it('should track CPU timeout extension in ExecutionStatus', async () => {
    const { ExecutionStatusTracker } = await import(
      '../../../../../src/tools/page/handlers/timeout-utils'
    );

    const tracker = new ExecutionStatusTracker({
      originalTimeoutMs: 60000,
      effectiveTimeoutMs: 180000, // Extended for CPU
      strategy: 'progressive',
      partialResultsEnabled: true,
      timeoutExtended: true,
      cpuModeExtended: true, // 新しいフラグ
    });

    const status = tracker.toExecutionStatus();

    expect(status.timeout_extended).toBe(true);
    expect(status.original_timeout_ms).toBe(60000);
    expect(status.effective_timeout_ms).toBe(180000);
    expect(status.cpu_mode_extended).toBe(true);
  });

  it('should include hardware info in ExecutionStatus', async () => {
    const { ExecutionStatusTracker } = await import(
      '../../../../../src/tools/page/handlers/timeout-utils'
    );

    const tracker = new ExecutionStatusTracker({
      originalTimeoutMs: 60000,
      effectiveTimeoutMs: 600000,
      strategy: 'progressive',
      partialResultsEnabled: true,
      timeoutExtended: true,
      hardwareInfo: {
        type: HardwareType.CPU,
        vramBytes: 0,
        isGpuAvailable: false,
      },
    });

    const status = tracker.toExecutionStatus();

    expect(status.hardware_type).toBe('CPU');
  });
});
