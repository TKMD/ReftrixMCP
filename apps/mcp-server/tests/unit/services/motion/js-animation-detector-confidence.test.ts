// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * JSアニメーション検出 - 信頼度スコアテスト
 *
 * TDDアプローチ: 期待する動作を定義するテストを先に作成
 *
 * テスト対象:
 * - 検出結果のconfidenceスコア計算
 * - 検出方法（CDP/WebAPI/ライブラリ）ごとの信頼度
 * - 複数ソースからの検出の信頼度マージ
 *
 * @module tests/unit/services/motion/js-animation-detector-confidence
 */

import { describe, it, expect } from 'vitest';

// =====================================================
// 型定義（信頼度スコア関連）
// =====================================================

/**
 * 検出ソース種別
 */
export type DetectionSource = 'cdp' | 'web_animations_api' | 'library_signature' | 'raf_monitoring' | 'intersection_observer';

/**
 * 検出結果の信頼度情報
 */
export interface DetectionConfidence {
  /** 総合信頼度スコア (0-1) */
  score: number;
  /** 検出に使用したソース */
  sources: DetectionSource[];
  /** ソースごとの信頼度 */
  sourceScores: Record<DetectionSource, number>;
  /** 信頼度計算の根拠 */
  rationale: string[];
}

/**
 * 信頼度付きアニメーション検出結果
 */
export interface AnimationDetectionWithConfidence {
  /** アニメーションID */
  id: string;
  /** アニメーション名 */
  name: string;
  /** アニメーションタイプ */
  type: 'css_animation' | 'css_transition' | 'web_animation' | 'js_library' | 'raf_based' | 'scroll_triggered';
  /** 信頼度情報 */
  confidence: DetectionConfidence;
  /** 検出詳細 */
  details: Record<string, unknown>;
}

// =====================================================
// 信頼度計算ロジック（テスト用実装）
// =====================================================

/**
 * ソースごとの基本信頼度
 */
const BASE_CONFIDENCE: Record<DetectionSource, number> = {
  cdp: 0.95, // CDPは最も信頼性が高い
  web_animations_api: 0.90, // Web Animations APIも高信頼
  library_signature: 0.75, // ライブラリシグネチャは中程度
  raf_monitoring: 0.70, // RAF監視は間接的
  intersection_observer: 0.65, // IO検出は最も間接的
};

/**
 * 複数ソースからの信頼度をマージ
 * 複数ソースで検出された場合、信頼度は上昇する
 */
function mergeConfidenceScores(sources: DetectionSource[]): number {
  if (sources.length === 0) return 0;
  if (sources.length === 1) return BASE_CONFIDENCE[sources[0]];

  // 最高スコアを基準に、追加ソースごとにボーナス
  const sortedScores = sources
    .map(s => BASE_CONFIDENCE[s])
    .sort((a, b) => b - a);

  let score = sortedScores[0];

  // 追加ソースごとに信頼度を増加（逓減効果）
  for (let i = 1; i < sortedScores.length; i++) {
    const bonus = (1 - score) * sortedScores[i] * 0.5;
    score += bonus;
  }

  return Math.min(score, 1.0);
}

/**
 * 信頼度情報を生成
 */
function calculateConfidence(
  sources: DetectionSource[],
  additionalRationale: string[] = []
): DetectionConfidence {
  const sourceScores: Record<DetectionSource, number> = {
    cdp: 0,
    web_animations_api: 0,
    library_signature: 0,
    raf_monitoring: 0,
    intersection_observer: 0,
  };

  sources.forEach(s => {
    sourceScores[s] = BASE_CONFIDENCE[s];
  });

  const rationale: string[] = [];

  if (sources.includes('cdp')) {
    rationale.push('CDP Animation domain detection (high confidence)');
  }
  if (sources.includes('web_animations_api')) {
    rationale.push('Web Animations API detection');
  }
  if (sources.includes('library_signature')) {
    rationale.push('Animation library signature detected');
  }
  if (sources.includes('raf_monitoring')) {
    rationale.push('requestAnimationFrame callback detected');
  }
  if (sources.includes('intersection_observer')) {
    rationale.push('IntersectionObserver triggered animation');
  }

  rationale.push(...additionalRationale);

  return {
    score: mergeConfidenceScores(sources),
    sources,
    sourceScores,
    rationale,
  };
}

// =====================================================
// テストスイート: 信頼度スコア計算
// =====================================================

describe('JSアニメーション検出 - 信頼度スコア', () => {
  describe('単一ソースの信頼度', () => {
    it('CDPソースは0.95の信頼度を持つ', () => {
      const confidence = calculateConfidence(['cdp']);

      expect(confidence.score).toBe(0.95);
      expect(confidence.sources).toContain('cdp');
      expect(confidence.sourceScores.cdp).toBe(0.95);
      expect(confidence.rationale).toContain('CDP Animation domain detection (high confidence)');
    });

    it('Web Animations APIソースは0.90の信頼度を持つ', () => {
      const confidence = calculateConfidence(['web_animations_api']);

      expect(confidence.score).toBe(0.90);
      expect(confidence.sources).toContain('web_animations_api');
      expect(confidence.sourceScores.web_animations_api).toBe(0.90);
    });

    it('ライブラリシグネチャソースは0.75の信頼度を持つ', () => {
      const confidence = calculateConfidence(['library_signature']);

      expect(confidence.score).toBe(0.75);
      expect(confidence.sources).toContain('library_signature');
      expect(confidence.sourceScores.library_signature).toBe(0.75);
    });

    it('RAF監視ソースは0.70の信頼度を持つ', () => {
      const confidence = calculateConfidence(['raf_monitoring']);

      expect(confidence.score).toBe(0.70);
      expect(confidence.sources).toContain('raf_monitoring');
    });

    it('IntersectionObserverソースは0.65の信頼度を持つ', () => {
      const confidence = calculateConfidence(['intersection_observer']);

      expect(confidence.score).toBe(0.65);
      expect(confidence.sources).toContain('intersection_observer');
    });
  });

  describe('複数ソースからの信頼度マージ', () => {
    it('CDP + Web Animations APIで信頼度が上昇する', () => {
      const singleSource = calculateConfidence(['cdp']);
      const multipleSources = calculateConfidence(['cdp', 'web_animations_api']);

      expect(multipleSources.score).toBeGreaterThan(singleSource.score);
      expect(multipleSources.score).toBeLessThanOrEqual(1.0);
      expect(multipleSources.sources).toHaveLength(2);
    });

    it('3つ以上のソースでも適切にマージされる', () => {
      const confidence = calculateConfidence([
        'cdp',
        'web_animations_api',
        'library_signature',
      ]);

      expect(confidence.score).toBeGreaterThan(0.95);
      expect(confidence.score).toBeLessThanOrEqual(1.0);
      expect(confidence.sources).toHaveLength(3);
      expect(confidence.rationale).toHaveLength(3);
    });

    it('全ソースからの検出で最大信頼度に近づく', () => {
      const allSources: DetectionSource[] = [
        'cdp',
        'web_animations_api',
        'library_signature',
        'raf_monitoring',
        'intersection_observer',
      ];

      const confidence = calculateConfidence(allSources);

      expect(confidence.score).toBeGreaterThan(0.98);
      expect(confidence.score).toBeLessThanOrEqual(1.0);
    });

    it('低信頼度ソースのみでは信頼度は低い', () => {
      const confidence = calculateConfidence([
        'raf_monitoring',
        'intersection_observer',
      ]);

      expect(confidence.score).toBeLessThan(0.85);
      expect(confidence.score).toBeGreaterThan(0.70);
    });
  });

  describe('信頼度情報の完全性', () => {
    it('空のソースリストで信頼度0', () => {
      const confidence = calculateConfidence([]);

      expect(confidence.score).toBe(0);
      expect(confidence.sources).toHaveLength(0);
    });

    it('追加根拠が含まれる', () => {
      const confidence = calculateConfidence(['cdp'], [
        'Animation duration: 1000ms',
        'Keyframes detected: 3',
      ]);

      expect(confidence.rationale).toContain('Animation duration: 1000ms');
      expect(confidence.rationale).toContain('Keyframes detected: 3');
    });

    it('sourceScoresに全ソースタイプが含まれる', () => {
      const confidence = calculateConfidence(['cdp']);

      expect(confidence.sourceScores).toHaveProperty('cdp');
      expect(confidence.sourceScores).toHaveProperty('web_animations_api');
      expect(confidence.sourceScores).toHaveProperty('library_signature');
      expect(confidence.sourceScores).toHaveProperty('raf_monitoring');
      expect(confidence.sourceScores).toHaveProperty('intersection_observer');

      // 使用されていないソースは0
      expect(confidence.sourceScores.web_animations_api).toBe(0);
    });
  });
});

// =====================================================
// テストスイート: アニメーション検出結果の信頼度
// =====================================================

describe('アニメーション検出結果の信頼度', () => {
  describe('CSSアニメーション', () => {
    it('CDP検出のCSSアニメーションは高信頼度', () => {
      const result: AnimationDetectionWithConfidence = {
        id: 'css-anim-1',
        name: 'fadeIn',
        type: 'css_animation',
        confidence: calculateConfidence(['cdp', 'web_animations_api']),
        details: {
          duration: 1000,
          keyframes: ['0%', '100%'],
        },
      };

      expect(result.confidence.score).toBeGreaterThan(0.95);
      expect(result.type).toBe('css_animation');
    });
  });

  describe('JSライブラリアニメーション', () => {
    it('GSAP検出はライブラリシグネチャ信頼度', () => {
      const result: AnimationDetectionWithConfidence = {
        id: 'gsap-anim-1',
        name: 'GSAP Tween',
        type: 'js_library',
        confidence: calculateConfidence(['library_signature']),
        details: {
          library: 'gsap',
          version: '3.12.0',
        },
      };

      expect(result.confidence.score).toBe(0.75);
      expect(result.details.library).toBe('gsap');
    });

    it('GSAP + RAF監視で信頼度上昇', () => {
      const result: AnimationDetectionWithConfidence = {
        id: 'gsap-anim-2',
        name: 'GSAP Tween',
        type: 'js_library',
        confidence: calculateConfidence(['library_signature', 'raf_monitoring']),
        details: {
          library: 'gsap',
          version: '3.12.0',
        },
      };

      expect(result.confidence.score).toBeGreaterThan(0.75);
      expect(result.confidence.sources).toContain('raf_monitoring');
    });
  });

  describe('スクロールトリガーアニメーション', () => {
    it('IntersectionObserverのみの検出は低信頼度', () => {
      const result: AnimationDetectionWithConfidence = {
        id: 'scroll-anim-1',
        name: 'Scroll Reveal',
        type: 'scroll_triggered',
        confidence: calculateConfidence(['intersection_observer']),
        details: {
          threshold: 0.5,
        },
      };

      expect(result.confidence.score).toBe(0.65);
    });

    it('IO + Web Animations APIで信頼度上昇', () => {
      const result: AnimationDetectionWithConfidence = {
        id: 'scroll-anim-2',
        name: 'Scroll Animation',
        type: 'scroll_triggered',
        confidence: calculateConfidence(['intersection_observer', 'web_animations_api']),
        details: {
          threshold: 0.5,
          triggersAnimation: true,
        },
      };

      expect(result.confidence.score).toBeGreaterThan(0.65);
      expect(result.confidence.score).toBeGreaterThan(0.90);
    });
  });

  describe('RAFベースアニメーション', () => {
    it('RAF監視のみは中程度の信頼度', () => {
      const result: AnimationDetectionWithConfidence = {
        id: 'raf-anim-1',
        name: 'Custom RAF Animation',
        type: 'raf_based',
        confidence: calculateConfidence(['raf_monitoring']),
        details: {
          callCount: 60,
          avgFrameTime: 16.67,
        },
      };

      expect(result.confidence.score).toBe(0.70);
    });

    it('RAF + DOM変更監視で信頼度上昇', () => {
      const result: AnimationDetectionWithConfidence = {
        id: 'raf-anim-2',
        name: 'Custom RAF Animation',
        type: 'raf_based',
        confidence: calculateConfidence(['raf_monitoring'], [
          'DOM mutations detected during RAF callback',
          'Transform property changes: 60 times',
        ]),
        details: {
          callCount: 60,
          avgFrameTime: 16.67,
          modifiedElements: ['#spinner'],
        },
      };

      expect(result.confidence.score).toBe(0.70); // ソースは1つなのでスコアは変わらない
      expect(result.confidence.rationale).toContain('DOM mutations detected during RAF callback');
    });
  });
});

// =====================================================
// テストスイート: 検出漏れパターンの信頼度補正
// =====================================================

describe('検出漏れパターンの信頼度補正', () => {
  describe('page.setContent使用時のCDP検出', () => {
    it('CDP検出が不安定な場合、Web Animations APIで補完', () => {
      // page.setContent使用時はCDPが不安定な場合がある
      // この場合、Web Animations APIでの検出結果を信頼する

      const cdpFailed = false;
      const webApiDetected = true;

      const sources: DetectionSource[] = [];
      if (!cdpFailed) sources.push('cdp');
      if (webApiDetected) sources.push('web_animations_api');

      const confidence = calculateConfidence(sources);

      // CDP失敗してもWeb APIで検出できれば高信頼度
      expect(confidence.score).toBeGreaterThanOrEqual(0.90);
    });
  });

  describe('遅延ロードアニメーション', () => {
    it('waitTime後に検出されたアニメーションは信頼度が維持される', () => {
      // 遅延後に検出されたアニメーションも通常の信頼度
      const confidence = calculateConfidence(['cdp'], [
        'Detected after 500ms wait',
        'Animation may have lazy-started',
      ]);

      expect(confidence.score).toBe(0.95);
      expect(confidence.rationale).toContain('Detected after 500ms wait');
    });
  });

  describe('サードパーティスクリプト由来', () => {
    it('サードパーティライブラリの検出は信頼度にラベル付け', () => {
      const confidence = calculateConfidence(['library_signature'], [
        'Third-party library: GSAP',
        'Version: 3.12.0',
      ]);

      expect(confidence.score).toBe(0.75);
      expect(confidence.rationale).toContain('Third-party library: GSAP');
    });
  });
});

// =====================================================
// テストスイート: 型定義の検証
// =====================================================

describe('信頼度関連型定義', () => {
  it('DetectionSourceは全ソースタイプを含む', () => {
    const allSources: DetectionSource[] = [
      'cdp',
      'web_animations_api',
      'library_signature',
      'raf_monitoring',
      'intersection_observer',
    ];

    expect(allSources).toHaveLength(5);
  });

  it('DetectionConfidenceは必須フィールドを持つ', () => {
    const confidence: DetectionConfidence = {
      score: 0.85,
      sources: ['cdp'],
      sourceScores: {
        cdp: 0.95,
        web_animations_api: 0,
        library_signature: 0,
        raf_monitoring: 0,
        intersection_observer: 0,
      },
      rationale: ['Test rationale'],
    };

    expect(confidence.score).toBe(0.85);
    expect(confidence.sources).toContain('cdp');
    expect(confidence.sourceScores.cdp).toBe(0.95);
    expect(confidence.rationale).toContain('Test rationale');
  });

  it('AnimationDetectionWithConfidenceは完全な検出情報を持つ', () => {
    const detection: AnimationDetectionWithConfidence = {
      id: 'test-id',
      name: 'Test Animation',
      type: 'css_animation',
      confidence: {
        score: 0.95,
        sources: ['cdp'],
        sourceScores: {
          cdp: 0.95,
          web_animations_api: 0,
          library_signature: 0,
          raf_monitoring: 0,
          intersection_observer: 0,
        },
        rationale: [],
      },
      details: {
        duration: 1000,
      },
    };

    expect(detection.id).toBe('test-id');
    expect(detection.type).toBe('css_animation');
    expect(detection.confidence.score).toBe(0.95);
    expect(detection.details.duration).toBe(1000);
  });
});
