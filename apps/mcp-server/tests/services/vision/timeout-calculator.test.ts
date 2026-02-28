// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TimeoutCalculator - Unit Tests
 *
 * Vision CPU完走保証 Phase 1: タイムアウト計算機能のテスト
 *
 * タイムアウト値:
 * - GPU: 60秒
 * - CPU小画像 (< 100KB): 180秒
 * - CPU中画像 (100KB - 500KB): 600秒
 * - CPUフルページ (> 500KB): 1200秒
 */

import { describe, it, expect } from 'vitest';
import {
  TimeoutCalculator,
  HardwareType,
  ImageSize,
  VisionTimeouts,
} from '../../../src/services/vision/timeout-calculator.js';

describe('TimeoutCalculator', () => {
  const calculator = new TimeoutCalculator();

  // ==========================================================================
  // GPU Timeout Tests
  // ==========================================================================

  describe('GPU Timeout', () => {
    it('should return 60 seconds for GPU regardless of image size', () => {
      const smallImage = calculator.calculate(HardwareType.GPU, 50_000);
      const mediumImage = calculator.calculate(HardwareType.GPU, 200_000);
      const largeImage = calculator.calculate(HardwareType.GPU, 1_000_000);

      expect(smallImage).toBe(VisionTimeouts.GPU);
      expect(mediumImage).toBe(VisionTimeouts.GPU);
      expect(largeImage).toBe(VisionTimeouts.GPU);
      expect(VisionTimeouts.GPU).toBe(60_000);
    });
  });

  // ==========================================================================
  // CPU Timeout Tests
  // ==========================================================================

  describe('CPU Timeout - Small Image', () => {
    it('should return 180 seconds for images < 100KB', () => {
      const result = calculator.calculate(HardwareType.CPU, 50_000);
      expect(result).toBe(VisionTimeouts.CPU_SMALL);
      expect(VisionTimeouts.CPU_SMALL).toBe(180_000);
    });

    it('should return 180 seconds for images at 99KB boundary', () => {
      const result = calculator.calculate(HardwareType.CPU, 99_999);
      expect(result).toBe(VisionTimeouts.CPU_SMALL);
    });
  });

  describe('CPU Timeout - Medium Image', () => {
    it('should return 600 seconds for images 100KB - 500KB', () => {
      const result = calculator.calculate(HardwareType.CPU, 200_000);
      expect(result).toBe(VisionTimeouts.CPU_MEDIUM);
      expect(VisionTimeouts.CPU_MEDIUM).toBe(600_000);
    });

    it('should return 600 seconds for images at 100KB boundary', () => {
      const result = calculator.calculate(HardwareType.CPU, 100_000);
      expect(result).toBe(VisionTimeouts.CPU_MEDIUM);
    });

    it('should return 600 seconds for images at 499KB boundary', () => {
      const result = calculator.calculate(HardwareType.CPU, 499_999);
      expect(result).toBe(VisionTimeouts.CPU_MEDIUM);
    });
  });

  describe('CPU Timeout - Large Image (Full Page)', () => {
    it('should return 1200 seconds for images > 500KB', () => {
      const result = calculator.calculate(HardwareType.CPU, 600_000);
      expect(result).toBe(VisionTimeouts.CPU_LARGE);
      expect(VisionTimeouts.CPU_LARGE).toBe(1_200_000);
    });

    it('should return 1200 seconds for images at 500KB boundary', () => {
      const result = calculator.calculate(HardwareType.CPU, 500_000);
      expect(result).toBe(VisionTimeouts.CPU_LARGE);
    });

    it('should return 1200 seconds for very large images', () => {
      const result = calculator.calculate(HardwareType.CPU, 5_000_000);
      expect(result).toBe(VisionTimeouts.CPU_LARGE);
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('Edge Cases', () => {
    it('should handle zero image size as small', () => {
      const result = calculator.calculate(HardwareType.CPU, 0);
      expect(result).toBe(VisionTimeouts.CPU_SMALL);
    });

    it('should handle negative image size as small', () => {
      const result = calculator.calculate(HardwareType.CPU, -1000);
      expect(result).toBe(VisionTimeouts.CPU_SMALL);
    });

    it('should handle undefined image size for GPU', () => {
      const result = calculator.calculate(HardwareType.GPU);
      expect(result).toBe(VisionTimeouts.GPU);
    });

    it('should handle undefined image size for CPU (default to medium)', () => {
      const result = calculator.calculate(HardwareType.CPU);
      expect(result).toBe(VisionTimeouts.CPU_MEDIUM);
    });
  });

  // ==========================================================================
  // Image Size Classification
  // ==========================================================================

  describe('Image Size Classification', () => {
    it('should classify image size correctly', () => {
      expect(calculator.classifyImageSize(50_000)).toBe(ImageSize.SMALL);
      expect(calculator.classifyImageSize(100_000)).toBe(ImageSize.MEDIUM);
      expect(calculator.classifyImageSize(300_000)).toBe(ImageSize.MEDIUM);
      expect(calculator.classifyImageSize(500_000)).toBe(ImageSize.LARGE);
      expect(calculator.classifyImageSize(1_000_000)).toBe(ImageSize.LARGE);
    });
  });

  // ==========================================================================
  // Timeout Constants
  // ==========================================================================

  describe('Timeout Constants', () => {
    it('should export correct timeout values', () => {
      expect(VisionTimeouts.GPU).toBe(60_000); // 60 seconds
      expect(VisionTimeouts.CPU_SMALL).toBe(180_000); // 3 minutes
      expect(VisionTimeouts.CPU_MEDIUM).toBe(600_000); // 10 minutes
      expect(VisionTimeouts.CPU_LARGE).toBe(1_200_000); // 20 minutes
    });
  });

  // ==========================================================================
  // Integration with HardwareInfo
  // ==========================================================================

  describe('Integration with HardwareInfo', () => {
    it('should calculate timeout from HardwareInfo object', () => {
      const gpuInfo = { type: HardwareType.GPU, vramBytes: 4_000_000_000, isGpuAvailable: true };
      const cpuInfo = { type: HardwareType.CPU, vramBytes: 0, isGpuAvailable: false };

      expect(calculator.calculateFromHardwareInfo(gpuInfo, 200_000)).toBe(VisionTimeouts.GPU);
      expect(calculator.calculateFromHardwareInfo(cpuInfo, 200_000)).toBe(VisionTimeouts.CPU_MEDIUM);
    });
  });

  // ==========================================================================
  // Human-readable Format
  // ==========================================================================

  describe('Human-readable Format', () => {
    it('should format timeout as human-readable string', () => {
      expect(calculator.formatTimeout(VisionTimeouts.GPU)).toBe('1m 0s');
      expect(calculator.formatTimeout(VisionTimeouts.CPU_SMALL)).toBe('3m 0s');
      expect(calculator.formatTimeout(VisionTimeouts.CPU_MEDIUM)).toBe('10m 0s');
      expect(calculator.formatTimeout(VisionTimeouts.CPU_LARGE)).toBe('20m 0s');
    });
  });
});
