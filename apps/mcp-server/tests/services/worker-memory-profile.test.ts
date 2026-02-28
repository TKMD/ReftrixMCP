// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker Memory Profile テスト
 *
 * TDD Red: システムメモリに基づくワーカーメモリ閾値の動的計算を検証する。
 *
 * computeMemoryProfile():
 *   os.totalmem() ベースで全メモリ閾値を算出
 *
 * resolveMemoryConfig():
 *   環境変数オーバーライド → computeMemoryProfile() フォールバック
 *
 * @module tests/services/worker-memory-profile
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  computeMemoryProfile,
  resolveMemoryConfig,
  type MemoryProfile,
} from '../../src/services/worker-memory-profile';

// =====================================================
// Helper: MB → bytes 変換
// =====================================================

function mbToBytes(mb: number): number {
  return mb * 1024 * 1024;
}

// =====================================================
// Helper: clamp 期待値計算
// =====================================================

function expectedClamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// =====================================================
// computeMemoryProfile テスト
// =====================================================

describe('computeMemoryProfile', () => {
  describe('8GB (8192MB) マシン', () => {
    const totalMb = 8192;
    let profile: MemoryProfile;

    beforeEach(() => {
      profile = computeMemoryProfile(mbToBytes(totalMb));
    });

    it('totalMemoryMb が 8192 である', () => {
      expect(profile.totalMemoryMb).toBe(8192);
    });

    it('degradationThresholdMb = min(8192 * 0.60, 12288) = 4915', () => {
      expect(profile.degradationThresholdMb).toBe(Math.floor(8192 * 0.60));
    });

    it('criticalThresholdMb = min(8192 * 0.70, 14336) = 5734', () => {
      expect(profile.criticalThresholdMb).toBe(Math.floor(8192 * 0.70));
    });

    it('selfExitThresholdMb = min(8192 * 0.70, 12288) = 5734', () => {
      expect(profile.selfExitThresholdMb).toBe(Math.floor(8192 * 0.70));
    });

    it('maxOldSpaceSizeMb = min(8192 * 0.50, 8192) = 4096', () => {
      expect(profile.maxOldSpaceSizeMb).toBe(Math.floor(8192 * 0.50));
    });

    it('embeddingChunkSize = clamp(round(8192/32768*30), 5, 30) = 8', () => {
      expect(profile.embeddingChunkSize).toBe(
        expectedClamp(Math.round((8192 / 32768) * 30), 5, 30),
      );
    });

    it('jsAnimationEmbeddingChunkSize = clamp(round(8192/32768*50), 5, 50) = 13', () => {
      expect(profile.jsAnimationEmbeddingChunkSize).toBe(
        expectedClamp(Math.round((8192 / 32768) * 50), 5, 50),
      );
    });

    it('tier が "8gb" である', () => {
      expect(profile.tier).toBe('8gb');
    });
  });

  describe('16GB (16384MB) マシン', () => {
    const totalMb = 16384;
    let profile: MemoryProfile;

    beforeEach(() => {
      profile = computeMemoryProfile(mbToBytes(totalMb));
    });

    it('totalMemoryMb が 16384 である', () => {
      expect(profile.totalMemoryMb).toBe(16384);
    });

    it('degradationThresholdMb = min(16384 * 0.60, 12288) = 9830', () => {
      expect(profile.degradationThresholdMb).toBe(Math.floor(16384 * 0.60));
    });

    it('criticalThresholdMb = min(16384 * 0.70, 14336) = 11468', () => {
      expect(profile.criticalThresholdMb).toBe(Math.floor(16384 * 0.70));
    });

    it('selfExitThresholdMb = min(16384 * 0.70, 12288) = 11468', () => {
      expect(profile.selfExitThresholdMb).toBe(Math.floor(16384 * 0.70));
    });

    it('maxOldSpaceSizeMb = min(16384 * 0.50, 8192) = 8192', () => {
      expect(profile.maxOldSpaceSizeMb).toBe(Math.min(Math.floor(16384 * 0.50), 8192));
    });

    it('embeddingChunkSize = clamp(round(16384/32768*30), 5, 30) = 15', () => {
      expect(profile.embeddingChunkSize).toBe(
        expectedClamp(Math.round((16384 / 32768) * 30), 5, 30),
      );
    });

    it('jsAnimationEmbeddingChunkSize = clamp(round(16384/32768*50), 5, 50) = 25', () => {
      expect(profile.jsAnimationEmbeddingChunkSize).toBe(
        expectedClamp(Math.round((16384 / 32768) * 50), 5, 50),
      );
    });

    it('tier が "16gb" である', () => {
      expect(profile.tier).toBe('16gb');
    });
  });

  describe('32GB (32768MB) マシン - 現行値とのキャップ一致', () => {
    const totalMb = 32768;
    let profile: MemoryProfile;

    beforeEach(() => {
      profile = computeMemoryProfile(mbToBytes(totalMb));
    });

    it('totalMemoryMb が 32768 である', () => {
      expect(profile.totalMemoryMb).toBe(32768);
    });

    it('degradationThresholdMb = min(32768 * 0.60, 12288) = 12288 (キャップ到達)', () => {
      // 32768 * 0.60 = 19660.8 → min(19660, 12288) = 12288
      expect(profile.degradationThresholdMb).toBe(12288);
    });

    it('criticalThresholdMb = min(32768 * 0.70, 14336) = 14336 (キャップ到達)', () => {
      // 32768 * 0.70 = 22937.6 → min(22937, 14336) = 14336
      expect(profile.criticalThresholdMb).toBe(14336);
    });

    it('selfExitThresholdMb = min(32768 * 0.70, 12288) = 12288 (キャップ到達)', () => {
      // 32768 * 0.70 = 22937.6 → min(22937, 12288) = 12288
      expect(profile.selfExitThresholdMb).toBe(12288);
    });

    it('maxOldSpaceSizeMb = min(32768 * 0.50, 8192) = 8192 (キャップ到達)', () => {
      // 32768 * 0.50 = 16384 → min(16384, 8192) = 8192
      expect(profile.maxOldSpaceSizeMb).toBe(8192);
    });

    it('embeddingChunkSize = clamp(round(32768/32768*30), 5, 30) = 30', () => {
      expect(profile.embeddingChunkSize).toBe(30);
    });

    it('jsAnimationEmbeddingChunkSize = clamp(round(32768/32768*50), 5, 50) = 50', () => {
      expect(profile.jsAnimationEmbeddingChunkSize).toBe(50);
    });

    it('tier が "32gb" である', () => {
      expect(profile.tier).toBe('32gb');
    });
  });

  describe('64GB (65536MB) マシン - キャップ効果', () => {
    const totalMb = 65536;
    let profile: MemoryProfile;

    beforeEach(() => {
      profile = computeMemoryProfile(mbToBytes(totalMb));
    });

    it('totalMemoryMb が 65536 である', () => {
      expect(profile.totalMemoryMb).toBe(65536);
    });

    it('degradationThresholdMb がキャップ 12288 に制限される', () => {
      // 65536 * 0.60 = 39321.6 → min(39321, 12288) = 12288
      expect(profile.degradationThresholdMb).toBe(12288);
    });

    it('criticalThresholdMb がキャップ 14336 に制限される', () => {
      // 65536 * 0.70 = 45875.2 → min(45875, 14336) = 14336
      expect(profile.criticalThresholdMb).toBe(14336);
    });

    it('selfExitThresholdMb がキャップ 12288 に制限される', () => {
      // 65536 * 0.70 = 45875.2 → min(45875, 12288) = 12288
      expect(profile.selfExitThresholdMb).toBe(12288);
    });

    it('maxOldSpaceSizeMb がキャップ 8192 に制限される', () => {
      // 65536 * 0.50 = 32768 → min(32768, 8192) = 8192
      expect(profile.maxOldSpaceSizeMb).toBe(8192);
    });

    it('embeddingChunkSize がキャップ 30 に制限される', () => {
      // round(65536/32768*30) = round(60) = 60 → clamp(60, 5, 30) = 30
      expect(profile.embeddingChunkSize).toBe(30);
    });

    it('jsAnimationEmbeddingChunkSize がキャップ 50 に制限される', () => {
      // round(65536/32768*50) = round(100) = 100 → clamp(100, 5, 50) = 50
      expect(profile.jsAnimationEmbeddingChunkSize).toBe(50);
    });

    it('tier が "64gb+" である', () => {
      expect(profile.tier).toBe('64gb+');
    });
  });

  describe('2GB (2048MB) マシン - 最小チャンクサイズ', () => {
    const totalMb = 2048;
    let profile: MemoryProfile;

    beforeEach(() => {
      profile = computeMemoryProfile(mbToBytes(totalMb));
    });

    it('totalMemoryMb が 2048 である', () => {
      expect(profile.totalMemoryMb).toBe(2048);
    });

    it('degradationThresholdMb = floor(2048 * 0.60) = 1228', () => {
      expect(profile.degradationThresholdMb).toBe(Math.floor(2048 * 0.60));
    });

    it('criticalThresholdMb = floor(2048 * 0.70) = 1433', () => {
      expect(profile.criticalThresholdMb).toBe(Math.floor(2048 * 0.70));
    });

    it('selfExitThresholdMb = floor(2048 * 0.70) = 1433', () => {
      expect(profile.selfExitThresholdMb).toBe(Math.floor(2048 * 0.70));
    });

    it('maxOldSpaceSizeMb = floor(2048 * 0.50) = 1024', () => {
      expect(profile.maxOldSpaceSizeMb).toBe(Math.floor(2048 * 0.50));
    });

    it('embeddingChunkSize が最小値 5 に制限される', () => {
      // round(2048/32768*30) = round(1.875) = 2 → clamp(2, 5, 30) = 5
      expect(profile.embeddingChunkSize).toBe(5);
    });

    it('jsAnimationEmbeddingChunkSize が最小値 5 に制限される', () => {
      // round(2048/32768*50) = round(3.125) = 3 → clamp(3, 5, 50) = 5
      expect(profile.jsAnimationEmbeddingChunkSize).toBe(5);
    });

    it('tier が "8gb" である（12288MB未満）', () => {
      expect(profile.tier).toBe('8gb');
    });
  });

  describe('degradation < critical 不変条件', () => {
    const testCases = [
      { label: '4GB', totalMb: 4096 },
      { label: '8GB', totalMb: 8192 },
      { label: '12GB', totalMb: 12288 },
      { label: '16GB', totalMb: 16384 },
      { label: '24GB', totalMb: 24576 },
      { label: '32GB', totalMb: 32768 },
      { label: '48GB', totalMb: 49152 },
      { label: '64GB', totalMb: 65536 },
      { label: '96GB', totalMb: 98304 },
      { label: '128GB', totalMb: 131072 },
    ];

    it.each(testCases)(
      '$label ($totalMb MB): degradation < critical',
      ({ totalMb }) => {
        const profile = computeMemoryProfile(mbToBytes(totalMb));
        expect(profile.degradationThresholdMb).toBeLessThan(profile.criticalThresholdMb);
      },
    );

    it.each(testCases)(
      '$label ($totalMb MB): selfExit <= critical',
      ({ totalMb }) => {
        const profile = computeMemoryProfile(mbToBytes(totalMb));
        expect(profile.selfExitThresholdMb).toBeLessThanOrEqual(profile.criticalThresholdMb);
      },
    );

    it.each(testCases)(
      '$label ($totalMb MB): maxOldSpace < degradation',
      ({ totalMb }) => {
        const profile = computeMemoryProfile(mbToBytes(totalMb));
        expect(profile.maxOldSpaceSizeMb).toBeLessThan(profile.degradationThresholdMb);
      },
    );

    it.each(testCases)(
      '$label ($totalMb MB): embeddingChunkSize は 5-30 の範囲内',
      ({ totalMb }) => {
        const profile = computeMemoryProfile(mbToBytes(totalMb));
        expect(profile.embeddingChunkSize).toBeGreaterThanOrEqual(5);
        expect(profile.embeddingChunkSize).toBeLessThanOrEqual(30);
      },
    );

    it.each(testCases)(
      '$label ($totalMb MB): jsAnimationEmbeddingChunkSize は 5-50 の範囲内',
      ({ totalMb }) => {
        const profile = computeMemoryProfile(mbToBytes(totalMb));
        expect(profile.jsAnimationEmbeddingChunkSize).toBeGreaterThanOrEqual(5);
        expect(profile.jsAnimationEmbeddingChunkSize).toBeLessThanOrEqual(50);
      },
    );
  });

  describe('引数なしの場合 os.totalmem() を使用', () => {
    it('totalMemoryMb が正の整数を返す', () => {
      const profile = computeMemoryProfile();
      expect(profile.totalMemoryMb).toBeGreaterThan(0);
      expect(Number.isInteger(profile.totalMemoryMb)).toBe(true);
    });

    it('全フィールドが正の数値を返す', () => {
      const profile = computeMemoryProfile();
      expect(profile.degradationThresholdMb).toBeGreaterThan(0);
      expect(profile.criticalThresholdMb).toBeGreaterThan(0);
      expect(profile.selfExitThresholdMb).toBeGreaterThan(0);
      expect(profile.maxOldSpaceSizeMb).toBeGreaterThan(0);
      expect(profile.embeddingChunkSize).toBeGreaterThanOrEqual(5);
      expect(profile.jsAnimationEmbeddingChunkSize).toBeGreaterThanOrEqual(5);
    });
  });
});

// =====================================================
// resolveMemoryConfig テスト
// =====================================================

describe('resolveMemoryConfig', () => {
  // 環境変数のクリーンアップ
  const envKeys = [
    'WORKER_MEMORY_DEGRADATION_MB',
    'WORKER_MEMORY_CRITICAL_MB',
    'WORKER_SELF_EXIT_THRESHOLD_MB',
    'WORKER_MAX_OLD_SPACE_MB',
    'WORKER_EMBEDDING_CHUNK_SIZE',
    'WORKER_JS_ANIMATION_CHUNK_SIZE',
  ] as const;

  const savedEnvValues: Record<string, string | undefined> = {};

  beforeEach(() => {
    // 現在の環境変数を保存
    for (const key of envKeys) {
      savedEnvValues[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // 環境変数を復元
    for (const key of envKeys) {
      if (savedEnvValues[key] !== undefined) {
        process.env[key] = savedEnvValues[key];
      } else {
        delete process.env[key];
      }
    }
  });

  describe('環境変数オーバーライド優先度', () => {
    it('WORKER_MEMORY_DEGRADATION_MB が設定されていれば優先される', () => {
      process.env.WORKER_MEMORY_DEGRADATION_MB = '9999';
      const config = resolveMemoryConfig();
      expect(config.degradationThresholdMb).toBe(9999);
    });

    it('WORKER_MEMORY_CRITICAL_MB が設定されていれば優先される', () => {
      process.env.WORKER_MEMORY_CRITICAL_MB = '13000';
      const config = resolveMemoryConfig();
      expect(config.criticalThresholdMb).toBe(13000);
    });

    it('WORKER_SELF_EXIT_THRESHOLD_MB が設定されていれば優先される', () => {
      process.env.WORKER_SELF_EXIT_THRESHOLD_MB = '11000';
      const config = resolveMemoryConfig();
      expect(config.selfExitThresholdMb).toBe(11000);
    });

    it('WORKER_MAX_OLD_SPACE_MB が設定されていれば優先される', () => {
      process.env.WORKER_MAX_OLD_SPACE_MB = '6000';
      const config = resolveMemoryConfig();
      expect(config.maxOldSpaceSizeMb).toBe(6000);
    });

    it('WORKER_EMBEDDING_CHUNK_SIZE が設定されていれば優先される', () => {
      process.env.WORKER_EMBEDDING_CHUNK_SIZE = '15';
      const config = resolveMemoryConfig();
      expect(config.embeddingChunkSize).toBe(15);
    });

    it('WORKER_JS_ANIMATION_CHUNK_SIZE が設定されていれば優先される', () => {
      process.env.WORKER_JS_ANIMATION_CHUNK_SIZE = '25';
      const config = resolveMemoryConfig();
      expect(config.jsAnimationEmbeddingChunkSize).toBe(25);
    });

    it('全環境変数を同時にオーバーライドできる', () => {
      process.env.WORKER_MEMORY_DEGRADATION_MB = '5000';
      process.env.WORKER_MEMORY_CRITICAL_MB = '7000';
      process.env.WORKER_SELF_EXIT_THRESHOLD_MB = '6000';
      process.env.WORKER_MAX_OLD_SPACE_MB = '4000';
      process.env.WORKER_EMBEDDING_CHUNK_SIZE = '10';
      process.env.WORKER_JS_ANIMATION_CHUNK_SIZE = '20';

      const config = resolveMemoryConfig();
      expect(config.degradationThresholdMb).toBe(5000);
      expect(config.criticalThresholdMb).toBe(7000);
      expect(config.selfExitThresholdMb).toBe(6000);
      expect(config.maxOldSpaceSizeMb).toBe(4000);
      expect(config.embeddingChunkSize).toBe(10);
      expect(config.jsAnimationEmbeddingChunkSize).toBe(20);
    });

    it('未設定の環境変数は computeMemoryProfile の値にフォールバックする', () => {
      // 全環境変数未設定 → computeMemoryProfile() と一致
      const config = resolveMemoryConfig();
      const baseline = computeMemoryProfile();

      expect(config.degradationThresholdMb).toBe(baseline.degradationThresholdMb);
      expect(config.criticalThresholdMb).toBe(baseline.criticalThresholdMb);
      expect(config.selfExitThresholdMb).toBe(baseline.selfExitThresholdMb);
      expect(config.maxOldSpaceSizeMb).toBe(baseline.maxOldSpaceSizeMb);
      expect(config.embeddingChunkSize).toBe(baseline.embeddingChunkSize);
      expect(config.jsAnimationEmbeddingChunkSize).toBe(baseline.jsAnimationEmbeddingChunkSize);
    });

    it('一部のみオーバーライドした場合、残りはフォールバックする', () => {
      process.env.WORKER_MEMORY_DEGRADATION_MB = '9999';
      // 他は未設定

      const config = resolveMemoryConfig();
      const baseline = computeMemoryProfile();

      expect(config.degradationThresholdMb).toBe(9999);
      expect(config.criticalThresholdMb).toBe(baseline.criticalThresholdMb);
      expect(config.selfExitThresholdMb).toBe(baseline.selfExitThresholdMb);
      expect(config.maxOldSpaceSizeMb).toBe(baseline.maxOldSpaceSizeMb);
    });
  });

  describe('無効な環境変数のフォールバック', () => {
    it('NaN文字列はフォールバックする', () => {
      process.env.WORKER_MEMORY_DEGRADATION_MB = 'not-a-number';
      const config = resolveMemoryConfig();
      const baseline = computeMemoryProfile();
      expect(config.degradationThresholdMb).toBe(baseline.degradationThresholdMb);
    });

    it('空文字列はフォールバックする', () => {
      process.env.WORKER_MEMORY_CRITICAL_MB = '';
      const config = resolveMemoryConfig();
      const baseline = computeMemoryProfile();
      expect(config.criticalThresholdMb).toBe(baseline.criticalThresholdMb);
    });

    it('負数はフォールバックする', () => {
      process.env.WORKER_MAX_OLD_SPACE_MB = '-100';
      const config = resolveMemoryConfig();
      const baseline = computeMemoryProfile();
      expect(config.maxOldSpaceSizeMb).toBe(baseline.maxOldSpaceSizeMb);
    });

    it('0はフォールバックする', () => {
      process.env.WORKER_EMBEDDING_CHUNK_SIZE = '0';
      const config = resolveMemoryConfig();
      const baseline = computeMemoryProfile();
      expect(config.embeddingChunkSize).toBe(baseline.embeddingChunkSize);
    });

    it('小数はフォールバックする（整数のみ受け付ける）', () => {
      process.env.WORKER_EMBEDDING_CHUNK_SIZE = '10.5';
      const config = resolveMemoryConfig();
      // safeParseInt は parseInt なので 10 をパースする（小数は切り捨て）
      // 10 は有効値（> 0）なのでオーバーライドされる
      expect(config.embeddingChunkSize).toBe(10);
    });

    it('Infinity はフォールバックする', () => {
      process.env.WORKER_MEMORY_DEGRADATION_MB = 'Infinity';
      const config = resolveMemoryConfig();
      const baseline = computeMemoryProfile();
      expect(config.degradationThresholdMb).toBe(baseline.degradationThresholdMb);
    });
  });

  describe('tier と totalMemoryMb は常に computeMemoryProfile ベース', () => {
    it('環境変数オーバーライドしても tier は変わらない', () => {
      process.env.WORKER_MEMORY_DEGRADATION_MB = '99999';
      const config = resolveMemoryConfig();
      const baseline = computeMemoryProfile();
      expect(config.tier).toBe(baseline.tier);
      expect(config.totalMemoryMb).toBe(baseline.totalMemoryMb);
    });
  });
});
