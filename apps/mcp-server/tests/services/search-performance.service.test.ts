// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 検索パフォーマンスSLO監視サービス テスト
 *
 * テスト対象: SearchPerformanceService (未実装)
 *
 * このテストは以下を検証します:
 * - 検索時間の記録と統計取得
 * - ツールごとのSLO定義と取得
 * - SLO違反の検出
 * - P50/P95/P99パーセンタイルの正確な計算
 * - ツールごとの独立した統計管理
 * - 統計のリセット機能
 *
 * TDDのRedフェーズ: 全テストが失敗することを期待
 */

import { describe, it, expect, beforeEach } from 'vitest';

// 実装が存在しないためインポートは失敗する
// このテストはTDDのRedフェーズとして作成
import {
  SearchPerformanceService,
  type SearchPerformanceStats,
  type SLODefinition,
} from '../../src/services/search-performance.service';

describe('SearchPerformanceService', () => {
  let service: SearchPerformanceService;

  beforeEach(() => {
    // 各テスト前にサービスを初期化
    service = new SearchPerformanceService();
  });

  describe('recordSearchTime - 検索時間の記録', () => {
    it('検索時間を記録し、統計から取得できること', () => {
      // Arrange
      const toolName = 'layout.search';
      const durationMs = 150;

      // Act
      service.recordSearchTime(toolName, durationMs);
      const stats = service.getStats(toolName);

      // Assert
      // 記録後はstatsが存在するはず
      expect(stats).toBeDefined();
      expect(stats?.count).toBe(1);
    });

    it('同一ツールに複数の検索時間を記録できること', () => {
      // Arrange
      const toolName = 'layout.search';
      const durations = [100, 200, 300, 400, 500];

      // Act
      durations.forEach((d) => service.recordSearchTime(toolName, d));
      const stats = service.getStats(toolName);

      // Assert
      expect(stats?.count).toBe(5);
    });

    it('負の値や0を記録してもエラーにならないこと', () => {
      // Arrange & Act & Assert
      // エラーがスローされないことを確認
      expect(() => service.recordSearchTime('layout.search', 0)).not.toThrow();
      expect(() => service.recordSearchTime('layout.search', -1)).not.toThrow();
    });
  });

  describe('getSLO - SLO定義の取得', () => {
    // Note: SVG機能は削除されたため、layout/motionのみテスト
    it('layout.searchのデフォルトSLOはP95 < 500msであること', () => {
      // Arrange & Act
      const slo = service.getSLO('layout.search');

      // Assert
      expect(slo).toBeDefined();
      expect(slo?.p95).toBe(500);
    });

    it('motion.searchのデフォルトSLOはP95 < 500msであること', () => {
      // Arrange & Act
      const slo = service.getSLO('motion.search');

      // Assert
      expect(slo).toBeDefined();
      expect(slo?.p95).toBe(500);
    });

    it('未定義のツールに対してはundefinedを返すこと', () => {
      // Arrange & Act
      const slo = service.getSLO('unknown.tool');

      // Assert
      expect(slo).toBeUndefined();
    });

    it('SLO定義にはp95とp99が含まれること', () => {
      // Arrange & Act
      const slo = service.getSLO('layout.search');

      // Assert
      expect(slo).toHaveProperty('p95');
      expect(slo).toHaveProperty('p99');
      expect(typeof slo?.p95).toBe('number');
      expect(typeof slo?.p99).toBe('number');
    });
  });

  describe('getStats - 統計取得', () => {
    it('未記録のツールに対してはundefinedを返すこと', () => {
      // Arrange & Act
      const stats = service.getStats('unknown.tool');

      // Assert
      expect(stats).toBeUndefined();
    });

    it('統計にcount, p50, p95, p99, sloViolationsが含まれること', () => {
      // Arrange
      service.recordSearchTime('layout.search', 100);

      // Act
      const stats = service.getStats('layout.search');

      // Assert
      expect(stats).toHaveProperty('count');
      expect(stats).toHaveProperty('p50');
      expect(stats).toHaveProperty('p95');
      expect(stats).toHaveProperty('p99');
      expect(stats).toHaveProperty('sloViolations');
    });

    it('ツールごとに独立した統計が保持されること', () => {
      // Arrange
      service.recordSearchTime('layout.search', 100);
      service.recordSearchTime('layout.search', 200);
      service.recordSearchTime('motion.search', 300);

      // Act
      const layoutStats = service.getStats('layout.search');
      const motionStats = service.getStats('motion.search');

      // Assert
      expect(layoutStats?.count).toBe(2);
      expect(motionStats?.count).toBe(1);
    });
  });

  describe('checkSLOViolation - SLO違反チェック', () => {
    it('P95 SLOを超える時間でtrueを返すこと', () => {
      // Arrange
      // layout.searchのP95 SLOは500ms
      const toolName = 'layout.search';
      const durationExceedingSLO = 600;

      // Act
      const isViolation = service.checkSLOViolation(toolName, durationExceedingSLO);

      // Assert
      expect(isViolation).toBe(true);
    });

    it('P95 SLO以下の時間でfalseを返すこと', () => {
      // Arrange
      const toolName = 'layout.search';
      const durationWithinSLO = 400;

      // Act
      const isViolation = service.checkSLOViolation(toolName, durationWithinSLO);

      // Assert
      expect(isViolation).toBe(false);
    });

    it('P95 SLOちょうどの時間でfalseを返すこと（境界値テスト）', () => {
      // Arrange
      const toolName = 'layout.search';
      const durationAtSLO = 500;

      // Act
      const isViolation = service.checkSLOViolation(toolName, durationAtSLO);

      // Assert
      expect(isViolation).toBe(false);
    });

    it('未定義ツールに対してはfalseを返すこと', () => {
      // Arrange
      const unknownTool = 'unknown.tool';

      // Act
      const isViolation = service.checkSLOViolation(unknownTool, 1000);

      // Assert
      expect(isViolation).toBe(false);
    });

    it('SLO違反を記録するとsloViolationsカウントが増加すること', () => {
      // Arrange
      const toolName = 'layout.search';

      // Act
      // 記録時にSLO違反が自動カウントされる
      service.recordSearchTime(toolName, 600); // 違反
      service.recordSearchTime(toolName, 700); // 違反
      service.recordSearchTime(toolName, 100); // 正常

      const stats = service.getStats(toolName);

      // Assert
      expect(stats?.sloViolations).toBe(2);
    });
  });

  describe('パーセンタイル計算', () => {
    it('P50（中央値）を正しく計算すること', () => {
      // Arrange
      // 100個のデータポイント: 1, 2, 3, ..., 100
      const toolName = 'layout.search';
      for (let i = 1; i <= 100; i++) {
        service.recordSearchTime(toolName, i);
      }

      // Act
      const stats = service.getStats(toolName);

      // Assert
      // P50は線形補間で計算: index = 99 * 0.5 = 49.5
      // sorted[49] = 50, sorted[50] = 51
      // 線形補間: 50 * 0.5 + 51 * 0.5 = 50.5
      expect(stats?.p50).toBeCloseTo(50.5, 1);
    });

    it('P95を正しく計算すること', () => {
      // Arrange
      const toolName = 'layout.search';
      for (let i = 1; i <= 100; i++) {
        service.recordSearchTime(toolName, i);
      }

      // Act
      const stats = service.getStats(toolName);

      // Assert
      // P95 = 95番目の値
      expect(stats?.p95).toBeCloseTo(95, 0);
    });

    it('P99を正しく計算すること', () => {
      // Arrange
      const toolName = 'layout.search';
      for (let i = 1; i <= 100; i++) {
        service.recordSearchTime(toolName, i);
      }

      // Act
      const stats = service.getStats(toolName);

      // Assert
      // P99 = 99番目の値
      expect(stats?.p99).toBeCloseTo(99, 0);
    });

    it('データが1件の場合、全パーセンタイルが同じ値になること', () => {
      // Arrange
      const toolName = 'layout.search';
      service.recordSearchTime(toolName, 250);

      // Act
      const stats = service.getStats(toolName);

      // Assert
      expect(stats?.p50).toBe(250);
      expect(stats?.p95).toBe(250);
      expect(stats?.p99).toBe(250);
    });

    it('データが2件の場合、パーセンタイルが正しく計算されること', () => {
      // Arrange
      const toolName = 'layout.search';
      service.recordSearchTime(toolName, 100);
      service.recordSearchTime(toolName, 200);

      // Act
      const stats = service.getStats(toolName);

      // Assert
      // P50は中央値（100と200の間）
      expect(stats?.p50).toBeGreaterThanOrEqual(100);
      expect(stats?.p50).toBeLessThanOrEqual(200);
    });

    it('外れ値がP99に反映されること', () => {
      // Arrange
      const toolName = 'layout.search';
      // 99個の正常値と1個の外れ値
      for (let i = 0; i < 99; i++) {
        service.recordSearchTime(toolName, 100);
      }
      service.recordSearchTime(toolName, 10000); // 外れ値

      // Act
      const stats = service.getStats(toolName);

      // Assert
      // P99は外れ値に近い値になるはず
      expect(stats?.p99).toBeGreaterThan(100);
      expect(stats?.p95).toBe(100); // P95は正常値
    });
  });

  describe('reset - 統計リセット', () => {
    it('全ツールの統計がリセットされること', () => {
      // Arrange
      service.recordSearchTime('layout.search', 100);
      service.recordSearchTime('motion.search', 200);

      // Act
      service.reset();

      // Assert
      expect(service.getStats('layout.search')).toBeUndefined();
      expect(service.getStats('motion.search')).toBeUndefined();
    });

    it('リセット後に新しいデータを記録できること', () => {
      // Arrange
      service.recordSearchTime('layout.search', 100);
      service.reset();

      // Act
      service.recordSearchTime('layout.search', 200);
      const stats = service.getStats('layout.search');

      // Assert
      expect(stats?.count).toBe(1);
      expect(stats?.p50).toBe(200);
    });

    it('リセット後もSLO定義は維持されること', () => {
      // Arrange
      service.recordSearchTime('layout.search', 100);
      service.reset();

      // Act
      const slo = service.getSLO('layout.search');

      // Assert
      expect(slo).toBeDefined();
      expect(slo?.p95).toBe(500);
    });
  });

  describe('DoS攻撃耐性（メモリ上限）', () => {
    it('ツール数上限（100）を超えた場合、新規ツールが記録されないこと', () => {
      // Arrange: 100個の異なるツールを登録
      for (let i = 0; i < 100; i++) {
        service.recordSearchTime(`tool_${i}`, 100);
      }

      // Act: 101個目のツールを登録試行
      service.recordSearchTime('tool_100', 100);

      // Assert: 101個目は登録されない
      expect(service.getStats('tool_100')).toBeUndefined();
      // 既存のツールは正常に動作
      expect(service.getStats('tool_0')).toBeDefined();
    });

    it('記録数上限（10000）を超えた場合、最古のデータが削除されること', () => {
      // Arrange: 10000件を記録
      const toolName = 'layout.search';
      for (let i = 1; i <= 10000; i++) {
        service.recordSearchTime(toolName, i);
      }

      // Act: 10001件目を記録（最古のデータ(1)が削除される）
      service.recordSearchTime(toolName, 10001);
      const stats = service.getStats(toolName);

      // Assert: 件数は10000を維持
      expect(stats?.count).toBe(10000);
      // P50（中央値）は最古のデータ(1)削除後の値になる
      // 2〜10001の中央値 = (5001 + 5002) / 2 = 5001.5
      expect(stats?.p50).toBeGreaterThan(1);
    });

    it('リングバッファ方式で古いデータから削除されること', () => {
      // Arrange: 異常に遅い検索を記録後、正常な検索で埋める
      const toolName = 'layout.search';
      service.recordSearchTime(toolName, 9999); // 異常値

      // 10000件の正常値で埋める
      for (let i = 0; i < 10000; i++) {
        service.recordSearchTime(toolName, 100);
      }

      const stats = service.getStats(toolName);

      // Assert: 異常値は押し出されている
      expect(stats?.count).toBe(10000);
      expect(stats?.p99).toBe(100); // 全て100なのでP99も100
    });
  });

  describe('エッジケースとエラーハンドリング', () => {
    it('非常に大きな値を記録してもオーバーフローしないこと', () => {
      // Arrange
      const toolName = 'layout.search';
      const largeValue = Number.MAX_SAFE_INTEGER;

      // Act & Assert
      expect(() => service.recordSearchTime(toolName, largeValue)).not.toThrow();
      const stats = service.getStats(toolName);
      expect(stats?.p50).toBe(largeValue);
    });

    it('小数点以下の値を正しく処理すること', () => {
      // Arrange
      const toolName = 'layout.search';
      service.recordSearchTime(toolName, 10.5);
      service.recordSearchTime(toolName, 20.7);
      service.recordSearchTime(toolName, 30.3);

      // Act
      const stats = service.getStats(toolName);

      // Assert
      expect(stats?.count).toBe(3);
      expect(stats?.p50).toBeCloseTo(20.7, 1);
    });

    it('空のツール名でも動作すること', () => {
      // Arrange & Act
      service.recordSearchTime('', 100);
      const stats = service.getStats('');

      // Assert
      expect(stats).toBeDefined();
      expect(stats?.count).toBe(1);
    });
  });

  describe('型定義の検証', () => {
    it('SearchPerformanceStatsの型が正しいこと', () => {
      // Arrange
      service.recordSearchTime('layout.search', 100);

      // Act
      const stats = service.getStats('layout.search');

      // Assert
      // TypeScriptの型チェックを通過することを確認
      if (stats) {
        const _count: number = stats.count;
        const _p50: number = stats.p50;
        const _p95: number = stats.p95;
        const _p99: number = stats.p99;
        const _sloViolations: number = stats.sloViolations;

        expect(typeof _count).toBe('number');
        expect(typeof _p50).toBe('number');
        expect(typeof _p95).toBe('number');
        expect(typeof _p99).toBe('number');
        expect(typeof _sloViolations).toBe('number');
      }
    });

    it('SLODefinitionの型が正しいこと', () => {
      // Arrange & Act
      const slo = service.getSLO('layout.search');

      // Assert
      if (slo) {
        const _p95: number = slo.p95;
        const _p99: number = slo.p99;

        expect(typeof _p95).toBe('number');
        expect(typeof _p99).toBe('number');
      }
    });
  });

  describe('統合シナリオ', () => {
    it('実際の使用パターンをシミュレートできること', () => {
      // Arrange: 1000件の検索をシミュレート
      const toolName = 'layout.search';
      const slo = service.getSLO(toolName);

      // 正規分布に近い検索時間を生成（平均200ms、標準偏差100ms）
      for (let i = 0; i < 1000; i++) {
        // Box-Muller変換で正規分布を生成
        const u1 = Math.random();
        const u2 = Math.random();
        const normalRandom = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        const duration = Math.max(10, 200 + normalRandom * 100);

        service.recordSearchTime(toolName, duration);
      }

      // Act
      const stats = service.getStats(toolName);

      // Assert
      expect(stats?.count).toBe(1000);
      expect(stats?.p50).toBeGreaterThan(0);
      expect(stats?.p95).toBeGreaterThan(stats?.p50 ?? 0);
      expect(stats?.p99).toBeGreaterThan(stats?.p95 ?? 0);

      // SLO定義と比較
      if (slo && stats) {
        // P95がSLO閾値付近または以下であることを期待
        // （シミュレーションデータの特性上、厳密な値は保証できない）
        expect(typeof stats.sloViolations).toBe('number');
      }
    });

    it('複数ツールの同時監視が正しく動作すること', () => {
      // Arrange
      // Note: SVG機能は削除されたため、layout/motionのみテスト
      const tools = ['layout.search', 'motion.search'];

      // 各ツールに異なる特性のデータを記録
      tools.forEach((tool, index) => {
        for (let i = 0; i < 100; i++) {
          // ツールごとに基準時間を変える
          const baseTime = (index + 1) * 50;
          service.recordSearchTime(tool, baseTime + Math.random() * 50);
        }
      });

      // Act & Assert
      tools.forEach((tool, index) => {
        const stats = service.getStats(tool);
        const slo = service.getSLO(tool);

        expect(stats).toBeDefined();
        expect(stats?.count).toBe(100);
        expect(slo).toBeDefined();

        // 各ツールのP50は基準時間に近い値であるはず
        const expectedBaseTime = (index + 1) * 50;
        expect(stats?.p50).toBeGreaterThanOrEqual(expectedBaseTime);
        expect(stats?.p50).toBeLessThanOrEqual(expectedBaseTime + 50);
      });
    });
  });
});
