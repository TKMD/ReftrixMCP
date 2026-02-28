// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.ingest MCPツール - レスポンシブ差異検出テスト
 *
 * TDD Red Phase: レスポンシブレイアウト解析機能のテスト
 *
 * 機能要件:
 * - 複数ビューポート（desktop/tablet/mobile）でのレイアウトキャプチャ
 * - ナビゲーションパターン変化の検出（horizontal-menu → hamburger-menu）
 * - 要素の表示/非表示変化の検出
 * - レイアウト構造変化の検出
 * - 差異サマリーの生成
 *
 * @module tests/tools/layout/ingest-responsive.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  responsiveViewportSchema,
  responsiveAnalysisOptionsSchema,
  responsiveAnalysisSchema,
  responsiveDifferenceSchema,
  DEFAULT_VIEWPORTS,
  type ResponsiveViewport,
  type ResponsiveAnalysis,
  type ResponsiveDifference,
} from '../../../src/tools/layout/schemas';

// ============================================================================
// Schema Validation Tests
// ============================================================================

describe('レスポンシブスキーマ検証', () => {
  describe('responsiveViewportSchema', () => {
    it('有効なビューポートを受け入れる', () => {
      const validViewport = { name: 'desktop', width: 1920, height: 1080 };
      const result = responsiveViewportSchema.safeParse(validViewport);
      expect(result.success).toBe(true);
    });

    it('name が空文字の場合はエラー', () => {
      const invalidViewport = { name: '', width: 1920, height: 1080 };
      const result = responsiveViewportSchema.safeParse(invalidViewport);
      expect(result.success).toBe(false);
    });

    it('width が 320 未満の場合はエラー', () => {
      const invalidViewport = { name: 'small', width: 319, height: 480 };
      const result = responsiveViewportSchema.safeParse(invalidViewport);
      expect(result.success).toBe(false);
    });

    it('width が 4096 を超える場合はエラー', () => {
      const invalidViewport = { name: 'huge', width: 4097, height: 1080 };
      const result = responsiveViewportSchema.safeParse(invalidViewport);
      expect(result.success).toBe(false);
    });

    it('height が 240 未満の場合はエラー', () => {
      const invalidViewport = { name: 'short', width: 320, height: 239 };
      const result = responsiveViewportSchema.safeParse(invalidViewport);
      expect(result.success).toBe(false);
    });
  });

  describe('responsiveAnalysisOptionsSchema', () => {
    it('デフォルト値が正しく設定される', () => {
      const result = responsiveAnalysisOptionsSchema.parse({});
      expect(result.enabled).toBe(false);
      expect(result.include_screenshots).toBe(true);
      expect(result.detect_navigation).toBe(true);
      expect(result.detect_visibility).toBe(true);
      expect(result.detect_layout).toBe(true);
    });

    it('enabled: true で有効化できる', () => {
      const result = responsiveAnalysisOptionsSchema.parse({ enabled: true });
      expect(result.enabled).toBe(true);
    });

    it('カスタムビューポートを指定できる', () => {
      const customViewports: ResponsiveViewport[] = [
        { name: 'small-mobile', width: 320, height: 568 },
        { name: 'large-desktop', width: 2560, height: 1440 },
      ];
      const result = responsiveAnalysisOptionsSchema.parse({
        enabled: true,
        viewports: customViewports,
      });
      expect(result.viewports).toHaveLength(2);
      expect(result.viewports?.[0].name).toBe('small-mobile');
    });

    it('viewports が 10 個を超える場合はエラー', () => {
      const tooManyViewports = Array.from({ length: 11 }, (_, i) => ({
        name: `viewport-${i}`,
        width: 320 + i * 100,
        height: 480,
      }));
      const result = responsiveAnalysisOptionsSchema.safeParse({
        enabled: true,
        viewports: tooManyViewports,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('responsiveDifferenceSchema', () => {
    it('visibility カテゴリの差異を受け入れる', () => {
      const difference = {
        element: 'nav.main-nav',
        description: 'デスクトップでは表示、モバイルでは非表示',
        category: 'visibility' as const,
        desktop: { visible: true },
        mobile: { visible: false },
      };
      const result = responsiveDifferenceSchema.safeParse(difference);
      expect(result.success).toBe(true);
    });

    it('navigation カテゴリの差異を受け入れる', () => {
      const difference = {
        element: 'header nav',
        description: 'ナビゲーションパターンが変化',
        category: 'navigation' as const,
        desktop: { type: 'horizontal-menu' },
        mobile: { type: 'hamburger-menu' },
      };
      const result = responsiveDifferenceSchema.safeParse(difference);
      expect(result.success).toBe(true);
    });

    it('layout カテゴリの差異を受け入れる', () => {
      const difference = {
        element: '.grid-container',
        description: 'グリッドレイアウトが変化',
        category: 'layout' as const,
        desktop: { columns: 3, display: 'grid' },
        mobile: { columns: 1, display: 'flex' },
      };
      const result = responsiveDifferenceSchema.safeParse(difference);
      expect(result.success).toBe(true);
    });
  });

  describe('responsiveAnalysisSchema', () => {
    it('完全な解析結果を受け入れる', () => {
      const analysis: ResponsiveAnalysis = {
        viewportsAnalyzed: ['desktop', 'tablet', 'mobile'],
        differences: [
          {
            element: 'nav',
            category: 'navigation',
            description: 'ナビゲーション変化',
            desktop: { type: 'horizontal-menu' },
            mobile: { type: 'hamburger-menu' },
          },
        ],
        breakpoints: ['768px', '1024px'],
        analysisTimeMs: 1500,
      };
      const result = responsiveAnalysisSchema.safeParse(analysis);
      expect(result.success).toBe(true);
    });
  });

  describe('DEFAULT_VIEWPORTS', () => {
    it('デフォルトビューポートは3種類（desktop/tablet/mobile）', () => {
      expect(DEFAULT_VIEWPORTS).toHaveLength(3);
      expect(DEFAULT_VIEWPORTS.map((v) => v.name)).toEqual(['desktop', 'tablet', 'mobile']);
    });

    it('desktop: 1920x1080', () => {
      const desktop = DEFAULT_VIEWPORTS.find((v) => v.name === 'desktop');
      expect(desktop?.width).toBe(1920);
      expect(desktop?.height).toBe(1080);
    });

    it('tablet: 768x1024', () => {
      const tablet = DEFAULT_VIEWPORTS.find((v) => v.name === 'tablet');
      expect(tablet?.width).toBe(768);
      expect(tablet?.height).toBe(1024);
    });

    it('mobile: 375x667', () => {
      const mobile = DEFAULT_VIEWPORTS.find((v) => v.name === 'mobile');
      expect(mobile?.width).toBe(375);
      expect(mobile?.height).toBe(667);
    });
  });
});

// ============================================================================
// Responsive Analysis Service Tests (TDD Red Phase)
// ============================================================================

describe('レスポンシブ解析サービス', () => {
  // NOTE: このテストは実装前なのでスキップ（TDD Red Phase準備）
  describe.skip('ResponsiveAnalysisService', () => {
    it('マルチビューポートキャプチャを実行できる', async () => {
      // TODO: 実装後に有効化
    });

    it('ナビゲーションパターン変化を検出できる', async () => {
      // TODO: 実装後に有効化
    });

    it('要素の表示/非表示変化を検出できる', async () => {
      // TODO: 実装後に有効化
    });
  });
});

// ============================================================================
// Navigation Pattern Detection Tests
// ============================================================================

describe('ナビゲーションパターン検出', () => {
  describe('detectNavigationType', () => {
    // ナビゲーションタイプ検出ロジックのユニットテスト
    // 実装: apps/mcp-server/src/services/responsive/navigation-detector.ts

    it.todo('水平メニューを検出できる');
    it.todo('ハンバーガーメニューを検出できる');
    it.todo('ドロワーメニューを検出できる');
    it.todo('ボトムナビゲーションを検出できる');
    it.todo('非表示ナビゲーションを検出できる');
  });

  describe('detectNavigationChange', () => {
    it.todo('desktop → mobile でのナビゲーション変化を検出');
    it.todo('tablet → mobile でのナビゲーション変化を検出');
    it.todo('変化がない場合は空配列を返す');
  });
});

// ============================================================================
// Element Visibility Detection Tests
// ============================================================================

describe('要素可視性検出', () => {
  describe('detectVisibilityChanges', () => {
    it.todo('display: none による非表示を検出');
    it.todo('visibility: hidden による非表示を検出');
    it.todo('opacity: 0 による非表示を検出');
    it.todo('@media クエリによる条件付き表示を検出');
  });

  describe('compareElementVisibility', () => {
    it.todo('ビューポート間での要素可視性の差異を検出');
    it.todo('同一の可視性の場合は差異なしと判定');
  });
});

// ============================================================================
// Layout Structure Detection Tests
// ============================================================================

describe('レイアウト構造検出', () => {
  describe('detectLayoutChanges', () => {
    it.todo('flex-direction の変化を検出');
    it.todo('grid-template-columns の変化を検出');
    it.todo('要素順序の変化を検出（order プロパティ）');
  });

  describe('extractLayoutStructure', () => {
    it.todo('グリッドレイアウトの列数を取得');
    it.todo('フレックスレイアウトの方向を取得');
    it.todo('要素の幅・高さを取得');
  });
});

// ============================================================================
// Multi-Viewport Capture Tests (Integration)
// ============================================================================

describe('マルチビューポートキャプチャ', () => {
  describe('captureAtViewport', () => {
    it.todo('指定したビューポートサイズでスクリーンショットを取得');
    it.todo('DOM構造をキャプチャ');
    it.todo('computed styles をキャプチャ');
  });

  describe('captureAllViewports', () => {
    it.todo('デフォルト3ビューポートでキャプチャを実行');
    it.todo('カスタムビューポートでキャプチャを実行');
    it.todo('並列キャプチャで効率化');
  });
});

// ============================================================================
// Difference Summary Generation Tests
// ============================================================================

describe('差異サマリー生成', () => {
  describe('generateDifferenceSummary', () => {
    it.todo('検出された差異からサマリーを生成');
    it.todo('カテゴリ別に差異をグループ化');
    it.todo('重要度でソート');
  });

  describe('formatDifferenceForOutput', () => {
    it.todo('MCP出力形式に変換');
    it.todo('日本語説明を生成');
  });
});

// ============================================================================
// Integration with layout.ingest Handler
// ============================================================================

describe('layout.ingest ハンドラー統合', () => {
  describe('responsive オプションが有効な場合', () => {
    it.todo('レスポンシブ解析結果が含まれる');
    it.todo('各ビューポートのスクリーンショットが含まれる');
    it.todo('差異一覧が含まれる');
    it.todo('検出されたブレークポイントが含まれる');
  });

  describe('responsive オプションが無効（デフォルト）の場合', () => {
    it.todo('レスポンシブ解析は実行されない');
    it.todo('responsiveAnalysis フィールドが undefined');
  });

  describe('エラーハンドリング', () => {
    it.todo('ビューポートキャプチャ失敗時のエラー処理');
    it.todo('タイムアウト時のエラー処理');
    it.todo('一部ビューポートのみ失敗した場合のパーシャル結果');
  });
});
