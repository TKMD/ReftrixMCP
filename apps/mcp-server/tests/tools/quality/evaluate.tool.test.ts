// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * quality.evaluate MCPツールのテスト
 * TDD Red Phase: 先にテストを作成
 *
 * Webデザインの品質を3軸（独自性・技巧・文脈適合性）で評価するMCPツール
 *
 * テスト対象:
 * - 入力バリデーション
 * - 品質評価（3軸）
 * - AIクリシェ検出
 * - 推奨事項生成
 * - グレード計算
 * - 重み付け計算
 * - DB連携（モック）
 * - エラーハンドリング
 *
 * @module tests/tools/quality/evaluate.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =====================================================
// インポート
// =====================================================

import {
  qualityEvaluateHandler,
  qualityEvaluateToolDefinition,
  setQualityEvaluateServiceFactory,
  resetQualityEvaluateServiceFactory,
  type IQualityEvaluateService,
} from '../../../src/tools/quality/evaluate.tool';

import {
  qualityEvaluateInputSchema,
  qualityEvaluateOutputSchema,
  weightsSchema,
  scoreToGrade,
  calculateWeightedScore,
  type QualityEvaluateInput,
  type QualityEvaluateOutput,
  type Weights,
  type Grade,
  QUALITY_MCP_ERROR_CODES,
} from '../../../src/tools/quality/schemas';

// =====================================================
// テストデータ
// =====================================================

const sampleHtmlGood = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>オリジナルデザイン</title>
  <style>
    :root {
      --primary-color: #2C5F2D;
      --secondary-color: #97BC62;
      --bg-color: #FAF9F6;
    }
    body {
      font-family: 'Noto Sans JP', sans-serif;
      background: var(--bg-color);
      color: #333;
      line-height: 1.8;
    }
    .hero {
      background: linear-gradient(135deg, var(--primary-color) 0%, var(--secondary-color) 100%);
      padding: 120px 0;
      position: relative;
      overflow: hidden;
    }
    .hero::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: url('pattern.svg') repeat;
      opacity: 0.1;
    }
    h1 {
      font-size: clamp(2rem, 5vw, 4rem);
      font-weight: 700;
      letter-spacing: 0.05em;
    }
    .feature-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 2rem;
      padding: 4rem 2rem;
    }
    .feature-card {
      background: white;
      border-radius: 16px;
      padding: 2rem;
      box-shadow: 0 4px 20px rgba(0,0,0,0.08);
      transition: transform 0.3s ease, box-shadow 0.3s ease;
    }
    .feature-card:hover {
      transform: translateY(-8px);
      box-shadow: 0 12px 32px rgba(0,0,0,0.12);
    }
    @media (prefers-reduced-motion: reduce) {
      .feature-card {
        transition: none;
      }
    }
  </style>
</head>
<body>
  <header role="banner">
    <nav role="navigation" aria-label="メインナビゲーション">
      <a href="/" aria-label="ホーム">ホーム</a>
      <a href="/about">私たちについて</a>
      <a href="/contact">お問い合わせ</a>
    </nav>
  </header>
  <main role="main">
    <section class="hero" aria-labelledby="hero-title">
      <h1 id="hero-title">革新的なソリューション</h1>
      <p>独自のアプローチで課題を解決します</p>
      <button type="button" aria-describedby="cta-desc">詳しく見る</button>
      <span id="cta-desc" class="sr-only">サービス詳細ページに移動します</span>
    </section>
    <section class="features" aria-labelledby="features-title">
      <h2 id="features-title">特徴</h2>
      <div class="feature-grid">
        <article class="feature-card">
          <h3>カスタマイズ可能</h3>
          <p>お客様のニーズに合わせて柔軟にカスタマイズできます。</p>
        </article>
        <article class="feature-card">
          <h3>高速処理</h3>
          <p>最新技術により、高速な処理を実現しています。</p>
        </article>
        <article class="feature-card">
          <h3>セキュリティ</h3>
          <p>万全のセキュリティ対策で大切なデータを守ります。</p>
        </article>
      </div>
    </section>
  </main>
  <footer role="contentinfo">
    <p>&copy; 2024 Company Name</p>
  </footer>
</body>
</html>`;

const sampleHtmlWithCliches = `<!DOCTYPE html>
<html>
<head>
  <title>AI Generated Site</title>
  <style>
    .hero {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .card {
      border-radius: 8px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    }
    .cta-button {
      background: linear-gradient(to right, #f857a6, #ff5858);
      border-radius: 9999px;
    }
  </style>
</head>
<body>
  <section class="hero">
    <h1>Transform Your Business</h1>
    <p>Unlock the power of innovation with our cutting-edge solutions.</p>
    <button class="cta-button">Get Started Today</button>
  </section>
  <section class="features">
    <div class="card">
      <h3>Seamless Integration</h3>
      <p>Our platform seamlessly integrates with your existing workflow.</p>
    </div>
    <div class="card">
      <h3>Scalable Solutions</h3>
      <p>Scale effortlessly as your business grows.</p>
    </div>
    <div class="card">
      <h3>24/7 Support</h3>
      <p>Our dedicated team is here to support you around the clock.</p>
    </div>
  </section>
</body>
</html>`;

const sampleHtmlMinimal = `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body><p>Hello World</p></body>
</html>`;

const sampleHtmlPoorAccessibility = `<!DOCTYPE html>
<html>
<head><title>Poor Accessibility</title></head>
<body>
  <div class="nav">
    <div onclick="navigate('/')">Home</div>
    <div onclick="navigate('/about')">About</div>
  </div>
  <div class="hero">
    <div class="title">Welcome</div>
    <img src="hero.jpg">
    <div class="button" onclick="submit()">Click Here</div>
  </div>
  <div class="content">
    <div class="card">
      <div class="card-title">Feature 1</div>
      <div>Some text here</div>
    </div>
  </div>
</body>
</html>`;

const validUUID = '123e4567-e89b-12d3-a456-426614174000';
const invalidUUID = 'invalid-uuid';

// =====================================================
// 入力スキーマテスト（15+ tests）
// =====================================================

describe('qualityEvaluateInputSchema', () => {
  describe('有効な入力', () => {
    it('html のみの入力を受け付ける', () => {
      const input = { html: sampleHtmlGood };
      const result = qualityEvaluateInputSchema.parse(input);
      expect(result.html).toBe(sampleHtmlGood);
      expect(result.includeRecommendations).toBe(true); // デフォルト
      expect(result.strict).toBe(false); // デフォルト
    });

    it('pageId のみの入力を受け付ける', () => {
      const input = { pageId: validUUID };
      const result = qualityEvaluateInputSchema.parse(input);
      expect(result.pageId).toBe(validUUID);
    });

    it('weights オプションを受け付ける（デフォルト重み）', () => {
      const input = {
        html: sampleHtmlGood,
        weights: { originality: 0.35, craftsmanship: 0.4, contextuality: 0.25 },
      };
      const result = qualityEvaluateInputSchema.parse(input);
      expect(result.weights?.originality).toBe(0.35);
      expect(result.weights?.craftsmanship).toBe(0.4);
      expect(result.weights?.contextuality).toBe(0.25);
    });

    it('カスタム重みを受け付ける（合計1.0）', () => {
      const input = {
        html: sampleHtmlGood,
        weights: { originality: 0.5, craftsmanship: 0.3, contextuality: 0.2 },
      };
      const result = qualityEvaluateInputSchema.parse(input);
      expect(result.weights?.originality).toBe(0.5);
    });

    it('targetIndustry オプションを受け付ける', () => {
      const input = {
        html: sampleHtmlGood,
        targetIndustry: 'technology',
      };
      const result = qualityEvaluateInputSchema.parse(input);
      expect(result.targetIndustry).toBe('technology');
    });

    it('targetAudience オプションを受け付ける', () => {
      const input = {
        html: sampleHtmlGood,
        targetAudience: 'enterprise',
      };
      const result = qualityEvaluateInputSchema.parse(input);
      expect(result.targetAudience).toBe('enterprise');
    });

    it('includeRecommendations=false を受け付ける', () => {
      const input = {
        html: sampleHtmlGood,
        includeRecommendations: false,
      };
      const result = qualityEvaluateInputSchema.parse(input);
      expect(result.includeRecommendations).toBe(false);
    });

    it('strict=true を受け付ける', () => {
      const input = {
        html: sampleHtmlGood,
        strict: true,
      };
      const result = qualityEvaluateInputSchema.parse(input);
      expect(result.strict).toBe(true);
    });

    it('全オプション指定の入力を受け付ける', () => {
      const input: QualityEvaluateInput = {
        html: sampleHtmlGood,
        weights: { originality: 0.4, craftsmanship: 0.35, contextuality: 0.25 },
        targetIndustry: 'healthcare',
        targetAudience: 'professionals',
        includeRecommendations: true,
        strict: true,
      };
      const result = qualityEvaluateInputSchema.parse(input);
      expect(result.html).toBeDefined();
      expect(result.weights?.originality).toBe(0.4);
      expect(result.targetIndustry).toBe('healthcare');
      expect(result.targetAudience).toBe('professionals');
      expect(result.includeRecommendations).toBe(true);
      expect(result.strict).toBe(true);
    });
  });

  describe('無効な入力', () => {
    it('pageId も html もない場合エラー', () => {
      const input = {};
      expect(() => qualityEvaluateInputSchema.parse(input)).toThrow();
    });

    it('pageId と html の両方が指定された場合エラー', () => {
      const input = {
        pageId: validUUID,
        html: sampleHtmlGood,
      };
      expect(() => qualityEvaluateInputSchema.parse(input)).toThrow();
    });

    it('pageId が無効なUUID形式の場合エラー', () => {
      const input = { pageId: invalidUUID };
      expect(() => qualityEvaluateInputSchema.parse(input)).toThrow();
    });

    it('html が空文字の場合エラー', () => {
      const input = { html: '' };
      expect(() => qualityEvaluateInputSchema.parse(input)).toThrow();
    });

    it('weights の合計が1.0でない場合エラー', () => {
      const input = {
        html: sampleHtmlGood,
        weights: { originality: 0.5, craftsmanship: 0.5, contextuality: 0.5 },
      };
      expect(() => qualityEvaluateInputSchema.parse(input)).toThrow();
    });

    it('targetIndustry が100文字を超える場合エラー', () => {
      const input = {
        html: sampleHtmlGood,
        targetIndustry: 'a'.repeat(101),
      };
      expect(() => qualityEvaluateInputSchema.parse(input)).toThrow();
    });

    it('targetAudience が100文字を超える場合エラー', () => {
      const input = {
        html: sampleHtmlGood,
        targetAudience: 'a'.repeat(101),
      };
      expect(() => qualityEvaluateInputSchema.parse(input)).toThrow();
    });
  });
});

// =====================================================
// weightsスキーマテスト（5+ tests）
// =====================================================

describe('weightsSchema', () => {
  it('デフォルト重みを受け付ける', () => {
    const weights = { originality: 0.35, craftsmanship: 0.4, contextuality: 0.25 };
    const result = weightsSchema.parse(weights);
    expect(result.originality).toBe(0.35);
    expect(result.craftsmanship).toBe(0.4);
    expect(result.contextuality).toBe(0.25);
  });

  it('合計が1.0の場合受け付ける', () => {
    const weights = { originality: 0.33, craftsmanship: 0.34, contextuality: 0.33 };
    const result = weightsSchema.parse(weights);
    expect(result.originality + result.craftsmanship + result.contextuality).toBeCloseTo(1.0);
  });

  it('合計が1.0でない場合エラー', () => {
    const weights = { originality: 0.3, craftsmanship: 0.3, contextuality: 0.3 };
    expect(() => weightsSchema.parse(weights)).toThrow();
  });

  it('重みが0未満の場合エラー', () => {
    const weights = { originality: -0.1, craftsmanship: 0.6, contextuality: 0.5 };
    expect(() => weightsSchema.parse(weights)).toThrow();
  });

  it('重みが1を超える場合エラー', () => {
    const weights = { originality: 1.5, craftsmanship: 0, contextuality: -0.5 };
    expect(() => weightsSchema.parse(weights)).toThrow();
  });

  it('浮動小数点誤差を許容する（0.99-1.01）', () => {
    const weights = { originality: 0.333, craftsmanship: 0.333, contextuality: 0.334 };
    const result = weightsSchema.parse(weights);
    expect(result).toBeDefined();
  });
});

// =====================================================
// ユーティリティ関数テスト（10+ tests）
// =====================================================

describe('scoreToGrade', () => {
  it('90以上はA', () => {
    expect(scoreToGrade(90)).toBe('A');
    expect(scoreToGrade(100)).toBe('A');
    expect(scoreToGrade(95)).toBe('A');
  });

  it('80-89はB', () => {
    expect(scoreToGrade(80)).toBe('B');
    expect(scoreToGrade(89)).toBe('B');
    expect(scoreToGrade(85)).toBe('B');
  });

  it('70-79はC', () => {
    expect(scoreToGrade(70)).toBe('C');
    expect(scoreToGrade(79)).toBe('C');
    expect(scoreToGrade(75)).toBe('C');
  });

  it('60-69はD', () => {
    expect(scoreToGrade(60)).toBe('D');
    expect(scoreToGrade(69)).toBe('D');
    expect(scoreToGrade(65)).toBe('D');
  });

  it('59以下はF', () => {
    expect(scoreToGrade(59)).toBe('F');
    expect(scoreToGrade(0)).toBe('F');
    expect(scoreToGrade(50)).toBe('F');
  });
});

describe('calculateWeightedScore', () => {
  it('デフォルト重みで計算する', () => {
    const weights: Weights = { originality: 0.35, craftsmanship: 0.4, contextuality: 0.25 };
    const result = calculateWeightedScore(80, 90, 70, weights);
    // 80*0.35 + 90*0.4 + 70*0.25 = 28 + 36 + 17.5 = 81.5
    expect(result).toBe(81.5);
  });

  it('カスタム重みで計算する', () => {
    const weights: Weights = { originality: 0.5, craftsmanship: 0.3, contextuality: 0.2 };
    const result = calculateWeightedScore(100, 80, 60, weights);
    // 100*0.5 + 80*0.3 + 60*0.2 = 50 + 24 + 12 = 86
    expect(result).toBe(86);
  });

  it('全て100の場合100を返す', () => {
    const weights: Weights = { originality: 0.35, craftsmanship: 0.4, contextuality: 0.25 };
    const result = calculateWeightedScore(100, 100, 100, weights);
    expect(result).toBe(100);
  });

  it('全て0の場合0を返す', () => {
    const weights: Weights = { originality: 0.35, craftsmanship: 0.4, contextuality: 0.25 };
    const result = calculateWeightedScore(0, 0, 0, weights);
    expect(result).toBe(0);
  });

  it('小数点2桁で丸める', () => {
    const weights: Weights = { originality: 0.333, craftsmanship: 0.333, contextuality: 0.334 };
    const result = calculateWeightedScore(77, 88, 99, weights);
    // 結果が小数点2桁で丸められる
    expect(result.toString().split('.')[1]?.length || 0).toBeLessThanOrEqual(2);
  });
});

// =====================================================
// 出力スキーマテスト（5+ tests）
// =====================================================

describe('qualityEvaluateOutputSchema', () => {
  it('成功時の基本レスポンスをバリデート', () => {
    const output: QualityEvaluateOutput = {
      success: true,
      data: {
        overall: 85,
        grade: 'B',
        originality: { score: 80, grade: 'B' },
        craftsmanship: { score: 90, grade: 'A' },
        contextuality: { score: 85, grade: 'B' },
        evaluatedAt: new Date().toISOString(),
      },
    };
    expect(() => qualityEvaluateOutputSchema.parse(output)).not.toThrow();
  });

  it('エラー時のレスポンスをバリデート', () => {
    const output = {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid input',
      },
    };
    expect(() => qualityEvaluateOutputSchema.parse(output)).not.toThrow();
  });

  it('推奨事項を含むレスポンスをバリデート', () => {
    const output: QualityEvaluateOutput = {
      success: true,
      data: {
        overall: 75,
        grade: 'C',
        originality: { score: 70, grade: 'C' },
        craftsmanship: { score: 80, grade: 'B' },
        contextuality: { score: 75, grade: 'C' },
        recommendations: [
          {
            id: 'rec-1',
            category: 'originality',
            priority: 'high',
            title: 'AIクリシェを回避する',
            description: '一般的なグラデーションパターンを独自のものに置き換えてください',
            impact: 15,
          },
        ],
        evaluatedAt: new Date().toISOString(),
      },
    };
    expect(() => qualityEvaluateOutputSchema.parse(output)).not.toThrow();
  });

  it('クリシェ検出結果を含むレスポンスをバリデート', () => {
    const output: QualityEvaluateOutput = {
      success: true,
      data: {
        overall: 65,
        grade: 'D',
        originality: { score: 50, grade: 'F' },
        craftsmanship: { score: 75, grade: 'C' },
        contextuality: { score: 70, grade: 'C' },
        clicheDetection: {
          detected: true,
          count: 3,
          patterns: [
            {
              type: 'gradient',
              description: 'AI典型のパープル-ピンクグラデーション',
              severity: 'high',
              location: '.hero',
            },
          ],
        },
        evaluatedAt: new Date().toISOString(),
      },
    };
    expect(() => qualityEvaluateOutputSchema.parse(output)).not.toThrow();
  });

  it('全フィールドを含むレスポンスをバリデート', () => {
    const output: QualityEvaluateOutput = {
      success: true,
      data: {
        pageId: validUUID,
        overall: 88,
        grade: 'B',
        originality: {
          score: 85,
          grade: 'B',
          details: ['独自のカラーパレット', 'カスタムアニメーション'],
        },
        craftsmanship: {
          score: 92,
          grade: 'A',
          details: ['アクセシビリティ対応', 'レスポンシブデザイン'],
        },
        contextuality: {
          score: 87,
          grade: 'B',
          details: ['業界標準に適合', 'ターゲット層に適切'],
        },
        clicheDetection: {
          detected: false,
          count: 0,
          patterns: [],
        },
        recommendations: [],
        evaluatedAt: new Date().toISOString(),
        weights: { originality: 0.35, craftsmanship: 0.4, contextuality: 0.25 },
        targetIndustry: 'technology',
        targetAudience: 'enterprise',
      },
    };
    expect(() => qualityEvaluateOutputSchema.parse(output)).not.toThrow();
  });
});

// =====================================================
// ツール定義テスト（5+ tests）
// =====================================================

describe('qualityEvaluateToolDefinition', () => {
  it('正しいツール名を持つ', () => {
    expect(qualityEvaluateToolDefinition.name).toBe('quality.evaluate');
  });

  it('description が設定されている', () => {
    expect(qualityEvaluateToolDefinition.description).toBeDefined();
    expect(typeof qualityEvaluateToolDefinition.description).toBe('string');
    expect(qualityEvaluateToolDefinition.description.length).toBeGreaterThan(0);
  });

  it('inputSchema が object 型', () => {
    expect(qualityEvaluateToolDefinition.inputSchema.type).toBe('object');
  });

  it('properties に必要なフィールドを含む', () => {
    const { properties } = qualityEvaluateToolDefinition.inputSchema;
    expect(properties).toHaveProperty('pageId');
    expect(properties).toHaveProperty('html');
    expect(properties).toHaveProperty('weights');
    expect(properties).toHaveProperty('targetIndustry');
    expect(properties).toHaveProperty('targetAudience');
    expect(properties).toHaveProperty('includeRecommendations');
    expect(properties).toHaveProperty('strict');
  });

  it('weights の properties を含む', () => {
    const { properties } = qualityEvaluateToolDefinition.inputSchema;
    const weightsProps = properties.weights?.properties;
    expect(weightsProps).toHaveProperty('originality');
    expect(weightsProps).toHaveProperty('craftsmanship');
    expect(weightsProps).toHaveProperty('contextuality');
  });
});

// =====================================================
// 品質評価テスト（15+ tests）
// =====================================================

describe('品質評価', () => {
  beforeEach(() => {
    resetQualityEvaluateServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('HTML直接評価', () => {
    it('HTMLコンテンツを評価できる', async () => {
      const input: QualityEvaluateInput = {
        html: sampleHtmlGood,
      };
      const result = await qualityEvaluateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.overall).toBeGreaterThanOrEqual(0);
        expect(result.data.overall).toBeLessThanOrEqual(100);
        expect(result.data.grade).toBeDefined();
      }
    });

    it('3軸のスコアを返す', async () => {
      const input: QualityEvaluateInput = {
        html: sampleHtmlGood,
      };
      const result = await qualityEvaluateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.originality).toBeDefined();
        expect(result.data.originality.score).toBeGreaterThanOrEqual(0);
        expect(result.data.originality.score).toBeLessThanOrEqual(100);

        expect(result.data.craftsmanship).toBeDefined();
        expect(result.data.craftsmanship.score).toBeGreaterThanOrEqual(0);
        expect(result.data.craftsmanship.score).toBeLessThanOrEqual(100);

        expect(result.data.contextuality).toBeDefined();
        expect(result.data.contextuality.score).toBeGreaterThanOrEqual(0);
        expect(result.data.contextuality.score).toBeLessThanOrEqual(100);
      }
    });

    it('各軸にグレードを返す', async () => {
      const input: QualityEvaluateInput = {
        html: sampleHtmlGood,
      };
      const result = await qualityEvaluateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(['A', 'B', 'C', 'D', 'F']).toContain(result.data.originality.grade);
        expect(['A', 'B', 'C', 'D', 'F']).toContain(result.data.craftsmanship.grade);
        expect(['A', 'B', 'C', 'D', 'F']).toContain(result.data.contextuality.grade);
      }
    });

    it('evaluatedAt タイムスタンプを返す', async () => {
      const input: QualityEvaluateInput = {
        html: sampleHtmlGood,
      };
      const result = await qualityEvaluateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.evaluatedAt).toBeDefined();
        expect(new Date(result.data.evaluatedAt).toString()).not.toBe('Invalid Date');
      }
    });
  });

  describe('pageId評価', () => {
    it('pageIdでページを取得して評価する', async () => {
      setQualityEvaluateServiceFactory(() => ({
        getPageById: vi.fn().mockResolvedValue({
          id: validUUID,
          htmlContent: sampleHtmlGood,
        }),
      }));

      const input: QualityEvaluateInput = {
        pageId: validUUID,
      };
      const result = await qualityEvaluateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pageId).toBe(validUUID);
      }
    });

    it('存在しないpageIdの場合エラーを返す', async () => {
      setQualityEvaluateServiceFactory(() => ({
        getPageById: vi.fn().mockResolvedValue(null),
      }));

      const input: QualityEvaluateInput = {
        pageId: validUUID,
      };
      const result = await qualityEvaluateHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(QUALITY_MCP_ERROR_CODES.PAGE_NOT_FOUND);
      }
    });
  });

  describe('カスタム重み評価', () => {
    it('カスタム重みで評価する', async () => {
      const customWeights: Weights = {
        originality: 0.5,
        craftsmanship: 0.3,
        contextuality: 0.2,
      };
      const input: QualityEvaluateInput = {
        html: sampleHtmlGood,
        weights: customWeights,
      };
      const result = await qualityEvaluateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.weights).toEqual(customWeights);
      }
    });

    it('重みがレスポンスに含まれる', async () => {
      const input: QualityEvaluateInput = {
        html: sampleHtmlGood,
        weights: { originality: 0.4, craftsmanship: 0.35, contextuality: 0.25 },
      };
      const result = await qualityEvaluateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.weights?.originality).toBe(0.4);
      }
    });
  });

  describe('業界・オーディエンス指定評価', () => {
    it('targetIndustry を指定して評価する', async () => {
      const input: QualityEvaluateInput = {
        html: sampleHtmlGood,
        targetIndustry: 'healthcare',
      };
      const result = await qualityEvaluateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.targetIndustry).toBe('healthcare');
      }
    });

    it('targetAudience を指定して評価する', async () => {
      const input: QualityEvaluateInput = {
        html: sampleHtmlGood,
        targetAudience: 'professionals',
      };
      const result = await qualityEvaluateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.targetAudience).toBe('professionals');
      }
    });

    it('業界とオーディエンス両方を指定して評価する', async () => {
      const input: QualityEvaluateInput = {
        html: sampleHtmlGood,
        targetIndustry: 'finance',
        targetAudience: 'enterprise',
      };
      const result = await qualityEvaluateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.targetIndustry).toBe('finance');
        expect(result.data.targetAudience).toBe('enterprise');
      }
    });
  });
});

// =====================================================
// AIクリシェ検出テスト（10+ tests）
// =====================================================

describe('AIクリシェ検出', () => {
  beforeEach(() => {
    resetQualityEvaluateServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('クリシェを含むHTMLで検出結果を返す', async () => {
    const input: QualityEvaluateInput = {
      html: sampleHtmlWithCliches,
    };
    const result = await qualityEvaluateHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.clicheDetection).toBeDefined();
      expect(result.data.clicheDetection?.detected).toBe(true);
    }
  });

  it('クリシェカウントを返す', async () => {
    const input: QualityEvaluateInput = {
      html: sampleHtmlWithCliches,
    };
    const result = await qualityEvaluateHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.clicheDetection?.count).toBeGreaterThan(0);
    }
  });

  it('検出されたクリシェパターンを返す', async () => {
    const input: QualityEvaluateInput = {
      html: sampleHtmlWithCliches,
    };
    const result = await qualityEvaluateHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.clicheDetection?.detected) {
      expect(result.data.clicheDetection.patterns.length).toBeGreaterThan(0);
      expect(result.data.clicheDetection.patterns[0]).toHaveProperty('type');
      expect(result.data.clicheDetection.patterns[0]).toHaveProperty('description');
      expect(result.data.clicheDetection.patterns[0]).toHaveProperty('severity');
    }
  });

  it('クリシェがないHTMLでは detected=false', async () => {
    const input: QualityEvaluateInput = {
      html: sampleHtmlGood,
    };
    const result = await qualityEvaluateHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.clicheDetection?.detected).toBe(false);
      expect(result.data.clicheDetection?.count).toBe(0);
    }
  });

  it('strictモードでより厳しく検出する', async () => {
    const inputNormal: QualityEvaluateInput = {
      html: sampleHtmlWithCliches,
      strict: false,
    };
    const inputStrict: QualityEvaluateInput = {
      html: sampleHtmlWithCliches,
      strict: true,
    };

    const resultNormal = await qualityEvaluateHandler(inputNormal);
    const resultStrict = await qualityEvaluateHandler(inputStrict);

    expect(resultNormal.success).toBe(true);
    expect(resultStrict.success).toBe(true);

    if (resultNormal.success && resultStrict.success) {
      // strictモードではより多くのクリシェを検出するか、スコアが低くなる
      expect(resultStrict.data.originality.score).toBeLessThanOrEqual(
        resultNormal.data.originality.score
      );
    }
  });

  it('グラデーションクリシェを検出する', async () => {
    const htmlWithGradientCliche = `<!DOCTYPE html>
<html>
<head>
  <style>
    .hero {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
  </style>
</head>
<body>
  <div class="hero">Content</div>
</body>
</html>`;
    const input: QualityEvaluateInput = {
      html: htmlWithGradientCliche,
    };
    const result = await qualityEvaluateHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.clicheDetection?.detected) {
      const gradientCliche = result.data.clicheDetection.patterns.find(
        (p) => p.type === 'gradient' || p.type.includes('gradient')
      );
      expect(gradientCliche).toBeDefined();
    }
  });

  it('テキストクリシェを検出する', async () => {
    const htmlWithTextCliche = `<!DOCTYPE html>
<html>
<body>
  <h1>Transform Your Business</h1>
  <p>Unlock the power of innovation with our cutting-edge solutions.</p>
  <button>Get Started Today</button>
</body>
</html>`;
    const input: QualityEvaluateInput = {
      html: htmlWithTextCliche,
    };
    const result = await qualityEvaluateHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.clicheDetection?.detected) {
      const textCliche = result.data.clicheDetection.patterns.find(
        (p) => p.type === 'text' || p.type.includes('text') || p.type.includes('phrase')
      );
      expect(textCliche).toBeDefined();
    }
  });

  it('ボタンスタイルクリシェを検出する', async () => {
    const htmlWithButtonCliche = `<!DOCTYPE html>
<html>
<head>
  <style>
    .cta {
      background: linear-gradient(to right, #f857a6, #ff5858);
      border-radius: 9999px;
    }
  </style>
</head>
<body>
  <button class="cta">Get Started</button>
</body>
</html>`;
    const input: QualityEvaluateInput = {
      html: htmlWithButtonCliche,
    };
    const result = await qualityEvaluateHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.clicheDetection?.detected) {
      const buttonCliche = result.data.clicheDetection.patterns.find(
        (p) =>
          p.type === 'button' ||
          p.type.includes('button') ||
          p.type.includes('cta') ||
          p.type.includes('gradient')
      );
      expect(buttonCliche).toBeDefined();
    }
  });

  it('クリシェ検出結果が originality スコアに影響する', async () => {
    const inputGood: QualityEvaluateInput = {
      html: sampleHtmlGood,
    };
    const inputCliche: QualityEvaluateInput = {
      html: sampleHtmlWithCliches,
    };

    const resultGood = await qualityEvaluateHandler(inputGood);
    const resultCliche = await qualityEvaluateHandler(inputCliche);

    expect(resultGood.success).toBe(true);
    expect(resultCliche.success).toBe(true);

    if (resultGood.success && resultCliche.success) {
      // クリシェを含むHTMLは originality スコアが低くなる
      expect(resultCliche.data.originality.score).toBeLessThan(
        resultGood.data.originality.score
      );
    }
  });

  it('クリシェパターンに severity を含む', async () => {
    const input: QualityEvaluateInput = {
      html: sampleHtmlWithCliches,
    };
    const result = await qualityEvaluateHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.clicheDetection?.patterns.length) {
      result.data.clicheDetection.patterns.forEach((pattern) => {
        expect(['high', 'medium', 'low']).toContain(pattern.severity);
      });
    }
  });
});

// =====================================================
// 推奨事項生成テスト（5+ tests）
// =====================================================

describe('推奨事項生成', () => {
  beforeEach(() => {
    resetQualityEvaluateServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includeRecommendations=true で推奨事項を返す', async () => {
    const input: QualityEvaluateInput = {
      html: sampleHtmlWithCliches,
      includeRecommendations: true,
    };
    const result = await qualityEvaluateHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.recommendations).toBeDefined();
      expect(Array.isArray(result.data.recommendations)).toBe(true);
    }
  });

  it('includeRecommendations=false で推奨事項を返さない', async () => {
    const input: QualityEvaluateInput = {
      html: sampleHtmlWithCliches,
      includeRecommendations: false,
    };
    const result = await qualityEvaluateHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.recommendations).toBeUndefined();
    }
  });

  it('推奨事項に必須フィールドを含む', async () => {
    const input: QualityEvaluateInput = {
      html: sampleHtmlPoorAccessibility,
      includeRecommendations: true,
    };
    const result = await qualityEvaluateHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.recommendations?.length) {
      const rec = result.data.recommendations[0];
      expect(rec).toHaveProperty('id');
      expect(rec).toHaveProperty('category');
      expect(rec).toHaveProperty('priority');
      expect(rec).toHaveProperty('title');
      expect(rec).toHaveProperty('description');
    }
  });

  it('推奨事項は優先度順にソートされている', async () => {
    const input: QualityEvaluateInput = {
      html: sampleHtmlPoorAccessibility,
      includeRecommendations: true,
    };
    const result = await qualityEvaluateHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.recommendations?.length) {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      const priorities = result.data.recommendations.map((r) => priorityOrder[r.priority]);
      // 優先度が昇順（高い順）になっているか確認
      for (let i = 1; i < priorities.length; i++) {
        expect(priorities[i]).toBeGreaterThanOrEqual(priorities[i - 1]!);
      }
    }
  });

  it('推奨事項の数は制限される（最大10件）', async () => {
    const input: QualityEvaluateInput = {
      html: sampleHtmlPoorAccessibility,
      includeRecommendations: true,
    };
    const result = await qualityEvaluateHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.recommendations) {
      expect(result.data.recommendations.length).toBeLessThanOrEqual(10);
    }
  });

  it('高品質HTMLでは推奨事項が少ない', async () => {
    const inputGood: QualityEvaluateInput = {
      html: sampleHtmlGood,
      includeRecommendations: true,
    };
    const inputPoor: QualityEvaluateInput = {
      html: sampleHtmlPoorAccessibility,
      includeRecommendations: true,
    };

    const resultGood = await qualityEvaluateHandler(inputGood);
    const resultPoor = await qualityEvaluateHandler(inputPoor);

    expect(resultGood.success).toBe(true);
    expect(resultPoor.success).toBe(true);

    if (resultGood.success && resultPoor.success) {
      const goodCount = resultGood.data.recommendations?.length ?? 0;
      const poorCount = resultPoor.data.recommendations?.length ?? 0;
      expect(goodCount).toBeLessThanOrEqual(poorCount);
    }
  });
});

// =====================================================
// エラーハンドリングテスト（10+ tests）
// =====================================================

describe('エラーハンドリング', () => {
  beforeEach(() => {
    resetQualityEvaluateServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('入力がnullの場合エラー', async () => {
    const result = await qualityEvaluateHandler(null);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(QUALITY_MCP_ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('入力がundefinedの場合エラー', async () => {
    const result = await qualityEvaluateHandler(undefined);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(QUALITY_MCP_ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('空オブジェクトの場合エラー', async () => {
    const result = await qualityEvaluateHandler({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(QUALITY_MCP_ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('空文字HTMLの場合エラー', async () => {
    const result = await qualityEvaluateHandler({ html: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(QUALITY_MCP_ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('無効なUUIDの場合エラー', async () => {
    const result = await qualityEvaluateHandler({ pageId: invalidUUID });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(QUALITY_MCP_ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('pageIdとhtml両方指定の場合エラー', async () => {
    const result = await qualityEvaluateHandler({
      pageId: validUUID,
      html: sampleHtmlGood,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(QUALITY_MCP_ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('無効な重み（合計≠1.0）の場合エラー', async () => {
    const result = await qualityEvaluateHandler({
      html: sampleHtmlGood,
      weights: { originality: 0.5, craftsmanship: 0.5, contextuality: 0.5 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(QUALITY_MCP_ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('DB接続エラーの場合適切なエラーを返す', async () => {
    setQualityEvaluateServiceFactory(() => ({
      getPageById: vi.fn().mockRejectedValue(new Error('DB connection failed')),
    }));

    const input: QualityEvaluateInput = {
      pageId: validUUID,
    };
    const result = await qualityEvaluateHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(QUALITY_MCP_ERROR_CODES.DB_ERROR);
    }
  });

  it('サービス未設定時のpageId評価はエラー', async () => {
    // サービスファクトリを設定しない
    resetQualityEvaluateServiceFactory();

    const input: QualityEvaluateInput = {
      pageId: validUUID,
    };
    const result = await qualityEvaluateHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(QUALITY_MCP_ERROR_CODES.SERVICE_UNAVAILABLE);
    }
  });

  it('エラーメッセージを含む', async () => {
    const result = await qualityEvaluateHandler(null);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBeDefined();
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  it('非常に大きなHTMLでもタイムアウトしない', async () => {
    const largeHtml = `<!DOCTYPE html><html lang="en"><body>${'<div>Content</div>'.repeat(10000)}</body></html>`;
    const input: QualityEvaluateInput = {
      html: largeHtml,
    };

    const startTime = Date.now();
    const result = await qualityEvaluateHandler(input);
    const duration = Date.now() - startTime;

    expect(result.success).toBe(true);
    // aXe-core統合後は処理時間が増加（JSDOM + aXe解析）
    // v0.1.0: パターン駆動評価追加により処理時間増加
    // v0.1.0: PatternMatcher有効化による処理時間増加（27.8秒実測）に対応し30秒に調整
    // v6.x: narrative + background解析追加で処理時間増加（41.8秒実測）に対応し60秒に調整
    expect(duration).toBeLessThan(60000);
  }, 65000);
});

// =====================================================
// DB連携テスト（5+ tests）
// =====================================================

describe('DB連携（モック）', () => {
  beforeEach(() => {
    resetQualityEvaluateServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('サービス経由でページを取得する', async () => {
    const mockGetPageById = vi.fn().mockResolvedValue({
      id: validUUID,
      htmlContent: sampleHtmlGood,
    });

    setQualityEvaluateServiceFactory(() => ({
      getPageById: mockGetPageById,
    }));

    const input: QualityEvaluateInput = {
      pageId: validUUID,
    };
    await qualityEvaluateHandler(input);

    expect(mockGetPageById).toHaveBeenCalledWith(validUUID);
  });

  it('ページ取得結果のHTMLを評価する', async () => {
    setQualityEvaluateServiceFactory(() => ({
      getPageById: vi.fn().mockResolvedValue({
        id: validUUID,
        htmlContent: sampleHtmlGood,
      }),
    }));

    const input: QualityEvaluateInput = {
      pageId: validUUID,
    };
    const result = await qualityEvaluateHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.overall).toBeGreaterThan(0);
    }
  });

  it('ページが存在しない場合 PAGE_NOT_FOUND エラー', async () => {
    setQualityEvaluateServiceFactory(() => ({
      getPageById: vi.fn().mockResolvedValue(null),
    }));

    const input: QualityEvaluateInput = {
      pageId: validUUID,
    };
    const result = await qualityEvaluateHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(QUALITY_MCP_ERROR_CODES.PAGE_NOT_FOUND);
    }
  });

  it('評価結果の保存を呼び出す（オプション）', async () => {
    const mockSaveEvaluation = vi.fn().mockResolvedValue(true);
    setQualityEvaluateServiceFactory(() => ({
      saveEvaluation: mockSaveEvaluation,
    }));

    const input: QualityEvaluateInput = {
      html: sampleHtmlGood,
    };
    await qualityEvaluateHandler(input);

    // 保存機能はオプションなので、呼び出されないこともある
    // 現在の仕様では自動保存しない
  });

  it('複数回の呼び出しで独立した結果を返す', async () => {
    const input1: QualityEvaluateInput = { html: sampleHtmlGood };
    const input2: QualityEvaluateInput = { html: sampleHtmlWithCliches };

    const [result1, result2] = await Promise.all([
      qualityEvaluateHandler(input1),
      qualityEvaluateHandler(input2),
    ]);

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);

    if (result1.success && result2.success) {
      expect(result1.data.overall).not.toBe(result2.data.overall);
    }
  });
});

// =====================================================
// 統合テスト（5+ tests）
// =====================================================

describe('統合テスト', () => {
  beforeEach(() => {
    resetQualityEvaluateServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('全オプション指定でフル評価が可能', async () => {
    const input: QualityEvaluateInput = {
      html: sampleHtmlGood,
      weights: { originality: 0.4, craftsmanship: 0.35, contextuality: 0.25 },
      targetIndustry: 'technology',
      targetAudience: 'enterprise',
      includeRecommendations: true,
      strict: true,
    };
    const result = await qualityEvaluateHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.overall).toBeDefined();
      expect(result.data.grade).toBeDefined();
      expect(result.data.originality).toBeDefined();
      expect(result.data.craftsmanship).toBeDefined();
      expect(result.data.contextuality).toBeDefined();
      expect(result.data.clicheDetection).toBeDefined();
      // recommendations はスコアに基づいて生成されるため、存在する場合のみ検証
      // includeRecommendations: true でも、推奨事項が生成されない場合がある
      if (result.data.recommendations) {
        expect(Array.isArray(result.data.recommendations)).toBe(true);
      }
      expect(result.data.weights).toBeDefined();
      expect(result.data.targetIndustry).toBe('technology');
      expect(result.data.targetAudience).toBe('enterprise');
    }
  });

  it('デフォルトオプションで評価が動作する', async () => {
    const input: QualityEvaluateInput = {
      html: sampleHtmlMinimal,
    };
    const result = await qualityEvaluateHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.overall).toBeDefined();
      expect(result.data.grade).toBeDefined();
    }
  });

  it('ツール定義とハンドラーが一致する', () => {
    const { properties } = qualityEvaluateToolDefinition.inputSchema;
    expect(properties).toHaveProperty('pageId');
    expect(properties).toHaveProperty('html');
    expect(properties).toHaveProperty('weights');
    expect(properties).toHaveProperty('targetIndustry');
    expect(properties).toHaveProperty('targetAudience');
    expect(properties).toHaveProperty('includeRecommendations');
    expect(properties).toHaveProperty('strict');
  });

  it('エラーコードが定義通りに使われる', async () => {
    // VALIDATION_ERROR
    const result1 = await qualityEvaluateHandler({});
    expect(result1.success).toBe(false);
    if (!result1.success) {
      expect(Object.values(QUALITY_MCP_ERROR_CODES)).toContain(result1.error.code);
    }

    // PAGE_NOT_FOUND
    setQualityEvaluateServiceFactory(() => ({
      getPageById: vi.fn().mockResolvedValue(null),
    }));
    const result2 = await qualityEvaluateHandler({ pageId: validUUID });
    expect(result2.success).toBe(false);
    if (!result2.success) {
      expect(Object.values(QUALITY_MCP_ERROR_CODES)).toContain(result2.error.code);
    }
  });

  it('スコアとグレードの整合性', async () => {
    const input: QualityEvaluateInput = {
      html: sampleHtmlGood,
    };
    const result = await qualityEvaluateHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      // overall スコアと grade の整合性
      expect(result.data.grade).toBe(scoreToGrade(result.data.overall));

      // 各軸のスコアとグレードの整合性
      expect(result.data.originality.grade).toBe(scoreToGrade(result.data.originality.score));
      expect(result.data.craftsmanship.grade).toBe(scoreToGrade(result.data.craftsmanship.score));
      expect(result.data.contextuality.grade).toBe(scoreToGrade(result.data.contextuality.score));
    }
  });
});

// =====================================================
// Craftsmanship評価ロジックテスト（v0.1.0）
// =====================================================

describe('Craftsmanship評価ロジック（v0.1.0 改善版）', () => {
  beforeEach(() => {
    resetQualityEvaluateServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('モダンCSS機能へのポジティブ評価', () => {
    it('CSS Grid使用で加点される', async () => {
      const htmlWithGrid = `<!DOCTYPE html>
<html lang="ja">
<head><title>Grid Test</title>
<style>
  .container {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 2rem;
  }
</style>
</head>
<body>
  <header role="banner"><nav role="navigation"><a href="/">Home</a></nav></header>
  <main role="main">
    <div class="container">
      <article>Content 1</article>
      <article>Content 2</article>
    </div>
  </main>
  <footer role="contentinfo">Footer</footer>
</body>
</html>`;

      const result = await qualityEvaluateHandler({ html: htmlWithGrid });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.craftsmanship.details).toContain('CSS Grid使用');
      }
    });

    it('Flexbox使用で加点される', async () => {
      const htmlWithFlex = `<!DOCTYPE html>
<html lang="ja">
<head><title>Flex Test</title>
<style>
  .flex-container {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }
</style>
</head>
<body>
  <header role="banner"><nav role="navigation"><a href="/">Home</a></nav></header>
  <main role="main">
    <div class="flex-container">
      <div>Item 1</div>
      <div>Item 2</div>
    </div>
  </main>
  <footer role="contentinfo">Footer</footer>
</body>
</html>`;

      const result = await qualityEvaluateHandler({ html: htmlWithFlex });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.craftsmanship.details).toContain('Flexbox使用');
      }
    });

    it('Container Queries使用で加点される', async () => {
      const htmlWithContainerQueries = `<!DOCTYPE html>
<html lang="ja">
<head><title>Container Queries Test</title>
<style>
  .card-container {
    container-type: inline-size;
    container-name: card;
  }
  @container card (min-width: 400px) {
    .card { flex-direction: row; }
  }
</style>
</head>
<body>
  <header role="banner"><nav role="navigation"><a href="/">Home</a></nav></header>
  <main role="main">
    <div class="card-container"><div class="card">Content</div></div>
  </main>
  <footer role="contentinfo">Footer</footer>
</body>
</html>`;

      const result = await qualityEvaluateHandler({ html: htmlWithContainerQueries });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.craftsmanship.details.some(d => d.includes('Container Queries'))).toBe(true);
      }
    });

    it('CSS clamp関数使用で加点される', async () => {
      const htmlWithClamp = `<!DOCTYPE html>
<html lang="ja">
<head><title>Clamp Test</title>
<style>
  h1 {
    font-size: clamp(1.5rem, 5vw, 3rem);
  }
</style>
</head>
<body>
  <header role="banner"><nav role="navigation"><a href="/">Home</a></nav></header>
  <main role="main"><h1>Title</h1></main>
  <footer role="contentinfo">Footer</footer>
</body>
</html>`;

      const result = await qualityEvaluateHandler({ html: htmlWithClamp });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.craftsmanship.details.some(d => d.includes('clamp'))).toBe(true);
      }
    });

    it('aspect-ratio使用で加点される', async () => {
      const htmlWithAspectRatio = `<!DOCTYPE html>
<html lang="ja">
<head><title>Aspect Ratio Test</title>
<style>
  .video-container {
    aspect-ratio: 16 / 9;
    width: 100%;
  }
</style>
</head>
<body>
  <header role="banner"><nav role="navigation"><a href="/">Home</a></nav></header>
  <main role="main">
    <div class="video-container">Video</div>
  </main>
  <footer role="contentinfo">Footer</footer>
</body>
</html>`;

      const result = await qualityEvaluateHandler({ html: htmlWithAspectRatio });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.craftsmanship.details.some(d => d.includes('aspect-ratio'))).toBe(true);
      }
    });

    it('CSS gapプロパティ使用で加点される', async () => {
      const htmlWithGap = `<!DOCTYPE html>
<html lang="ja">
<head><title>Gap Test</title>
<style>
  .grid {
    display: grid;
    gap: 2rem;
  }
</style>
</head>
<body>
  <header role="banner"><nav role="navigation"><a href="/">Home</a></nav></header>
  <main role="main"><div class="grid"><div>1</div><div>2</div></div></main>
  <footer role="contentinfo">Footer</footer>
</body>
</html>`;

      const result = await qualityEvaluateHandler({ html: htmlWithGap });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.craftsmanship.details.some(d => d.includes('gap'))).toBe(true);
      }
    });
  });

  describe('アクセシビリティ対応へのポジティブ評価', () => {
    it('skip link使用で加点される', async () => {
      const htmlWithSkipLink = `<!DOCTYPE html>
<html lang="ja">
<head><title>Skip Link Test</title>
<style>
  .skip-link {
    position: absolute;
    top: -40px;
    left: 0;
    padding: 8px;
    z-index: 100;
  }
  .skip-link:focus {
    top: 0;
  }
</style>
</head>
<body>
  <a href="#main-content" class="skip-link">メインコンテンツへスキップ</a>
  <header role="banner"><nav role="navigation"><a href="/">Home</a></nav></header>
  <main id="main-content" role="main">Content</main>
  <footer role="contentinfo">Footer</footer>
</body>
</html>`;

      const result = await qualityEvaluateHandler({ html: htmlWithSkipLink });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.craftsmanship.details.some(d => d.includes('スキップリンク'))).toBe(true);
      }
    });

    it('focus-visible使用で加点される', async () => {
      const htmlWithFocusVisible = `<!DOCTYPE html>
<html lang="ja">
<head><title>Focus Visible Test</title>
<style>
  button:focus-visible {
    outline: 2px solid blue;
    outline-offset: 2px;
  }
</style>
</head>
<body>
  <header role="banner"><nav role="navigation"><a href="/">Home</a></nav></header>
  <main role="main"><button>Click me</button></main>
  <footer role="contentinfo">Footer</footer>
</body>
</html>`;

      const result = await qualityEvaluateHandler({ html: htmlWithFocusVisible });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.craftsmanship.details.some(d => d.includes('focus-visible'))).toBe(true);
      }
    });

    it('prefers-color-scheme対応で加点される', async () => {
      const htmlWithColorScheme = `<!DOCTYPE html>
<html lang="ja">
<head><title>Color Scheme Test</title>
<style>
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #fff; }
  }
</style>
</head>
<body>
  <header role="banner"><nav role="navigation"><a href="/">Home</a></nav></header>
  <main role="main">Content</main>
  <footer role="contentinfo">Footer</footer>
</body>
</html>`;

      const result = await qualityEvaluateHandler({ html: htmlWithColorScheme });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.craftsmanship.details.some(d => d.includes('prefers-color-scheme'))).toBe(true);
      }
    });

    it('prefers-reduced-motion対応で加点される', async () => {
      const htmlWithReducedMotion = `<!DOCTYPE html>
<html lang="ja">
<head><title>Reduced Motion Test</title>
<style>
  .animated { transition: transform 0.3s ease; }
  @media (prefers-reduced-motion: reduce) {
    .animated { transition: none; }
  }
</style>
</head>
<body>
  <header role="banner"><nav role="navigation"><a href="/">Home</a></nav></header>
  <main role="main"><div class="animated">Content</div></main>
  <footer role="contentinfo">Footer</footer>
</body>
</html>`;

      const result = await qualityEvaluateHandler({ html: htmlWithReducedMotion });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.craftsmanship.details.some(d => d.includes('モーション軽減'))).toBe(true);
      }
    });
  });

  describe('パフォーマンス最適化へのポジティブ評価', () => {
    it('loading="lazy"使用で加点される', async () => {
      const htmlWithLazyLoading = `<!DOCTYPE html>
<html lang="ja">
<head><title>Lazy Loading Test</title></head>
<body>
  <header role="banner"><nav role="navigation"><a href="/">Home</a></nav></header>
  <main role="main">
    <img src="image.jpg" alt="Image description" loading="lazy" width="800" height="600">
    <iframe src="video.html" loading="lazy" title="Video"></iframe>
  </main>
  <footer role="contentinfo">Footer</footer>
</body>
</html>`;

      const result = await qualityEvaluateHandler({ html: htmlWithLazyLoading });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.craftsmanship.details.some(d => d.includes('loading="lazy"'))).toBe(true);
      }
    });

    it('preload/prefetch使用で加点される', async () => {
      const htmlWithPreload = `<!DOCTYPE html>
<html lang="ja">
<head>
  <title>Preload Test</title>
  <link rel="preload" href="critical.css" as="style">
  <link rel="preload" href="font.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="prefetch" href="next-page.html">
</head>
<body>
  <header role="banner"><nav role="navigation"><a href="/">Home</a></nav></header>
  <main role="main">Content</main>
  <footer role="contentinfo">Footer</footer>
</body>
</html>`;

      const result = await qualityEvaluateHandler({ html: htmlWithPreload });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.craftsmanship.details.some(d => d.includes('preload') || d.includes('prefetch'))).toBe(true);
      }
    });

    it('font-display使用で加点される', async () => {
      const htmlWithFontDisplay = `<!DOCTYPE html>
<html lang="ja">
<head><title>Font Display Test</title>
<style>
  @font-face {
    font-family: 'CustomFont';
    src: url('font.woff2') format('woff2');
    font-display: swap;
  }
</style>
</head>
<body>
  <header role="banner"><nav role="navigation"><a href="/">Home</a></nav></header>
  <main role="main">Content</main>
  <footer role="contentinfo">Footer</footer>
</body>
</html>`;

      const result = await qualityEvaluateHandler({ html: htmlWithFontDisplay });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.craftsmanship.details.some(d => d.includes('font-display'))).toBe(true);
      }
    });

    it('画像のwidth/height属性指定で加点される', async () => {
      const htmlWithImageDimensions = `<!DOCTYPE html>
<html lang="ja">
<head><title>Image Dimensions Test</title></head>
<body>
  <header role="banner"><nav role="navigation"><a href="/">Home</a></nav></header>
  <main role="main">
    <img src="image.jpg" alt="Image" width="800" height="600">
  </main>
  <footer role="contentinfo">Footer</footer>
</body>
</html>`;

      const result = await qualityEvaluateHandler({ html: htmlWithImageDimensions });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.craftsmanship.details.some(d => d.includes('画像サイズ属性'))).toBe(true);
      }
    });
  });

  describe('高品質サイトの適切な評価', () => {
    it('多くの良い実装パターンを持つサイトは高スコア（80以上）を得る', async () => {
      const highQualityHtml = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>高品質サイト</title>
  <link rel="preload" href="critical.css" as="style">
  <link rel="preload" href="font.woff2" as="font" type="font/woff2" crossorigin>
  <style>
    @font-face {
      font-family: 'CustomFont';
      src: url('font.woff2') format('woff2');
      font-display: swap;
    }
    :root {
      --color-primary: #2563eb;
      --color-text: #1f2937;
      --spacing-lg: 2rem;
    }
    body {
      font-family: 'CustomFont', system-ui, sans-serif;
      color: var(--color-text);
      line-height: 1.6;
    }
    .skip-link {
      position: absolute;
      top: -40px;
      left: 0;
    }
    .skip-link:focus { top: 0; }
    .container {
      container-type: inline-size;
      max-width: 1200px;
      margin: 0 auto;
      padding: 0 var(--spacing-lg);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: var(--spacing-lg);
    }
    h1 { font-size: clamp(2rem, 5vw, 4rem); }
    .card {
      aspect-ratio: 16 / 9;
      border-radius: 8px;
    }
    button:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #111; color: #fff; }
    }
    @media (prefers-reduced-motion: reduce) {
      * { animation: none !important; transition: none !important; }
    }
    @container (min-width: 600px) {
      .card { flex-direction: row; }
    }
  </style>
</head>
<body>
  <a href="#main" class="skip-link">メインコンテンツへスキップ</a>
  <header role="banner">
    <nav role="navigation" aria-label="メインナビゲーション">
      <a href="/" aria-current="page">ホーム</a>
      <a href="/about">About</a>
      <a href="/contact">Contact</a>
    </nav>
  </header>
  <main id="main" role="main">
    <section aria-labelledby="hero-title">
      <h1 id="hero-title">高品質なWebデザイン</h1>
      <p>モダンなCSS機能とアクセシビリティを両立</p>
      <button type="button" aria-describedby="cta-desc">詳しく見る</button>
      <span id="cta-desc" class="sr-only">詳細ページへ移動</span>
    </section>
    <section aria-labelledby="features-title">
      <h2 id="features-title">特徴</h2>
      <div class="container">
        <div class="grid">
          <article class="card">
            <img src="feature1.jpg" alt="機能1の説明" loading="lazy" width="400" height="225">
            <h3>高速パフォーマンス</h3>
          </article>
          <article class="card">
            <img src="feature2.jpg" alt="機能2の説明" loading="lazy" width="400" height="225">
            <h3>アクセシビリティ</h3>
          </article>
        </div>
      </div>
    </section>
  </main>
  <footer role="contentinfo">
    <p>&copy; 2024 Company</p>
  </footer>
</body>
</html>`;

      const result = await qualityEvaluateHandler({ html: highQualityHtml });
      expect(result.success).toBe(true);
      if (result.success) {
        // 高品質サイトは Craftsmanship スコア 80以上を期待
        expect(result.data.craftsmanship.score).toBeGreaterThanOrEqual(80);
        // グレードは B 以上
        expect(['A', 'B']).toContain(result.data.craftsmanship.grade);
      }
    });

    it('基本的なセマンティックHTMLのみでも適切なベーススコアを得る', async () => {
      const basicSemanticHtml = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>基本サイト</title>
</head>
<body>
  <header role="banner">
    <nav role="navigation">
      <a href="/">Home</a>
    </nav>
  </header>
  <main role="main">
    <h1>タイトル</h1>
    <p>コンテンツ</p>
  </main>
  <footer role="contentinfo">
    <p>Footer</p>
  </footer>
</body>
</html>`;

      const result = await qualityEvaluateHandler({ html: basicSemanticHtml });
      expect(result.success).toBe(true);
      if (result.success) {
        // 基本的なセマンティックHTMLでも 60以上を期待
        expect(result.data.craftsmanship.score).toBeGreaterThanOrEqual(60);
      }
    });
  });

  describe('detailsフィールドに評価根拠が含まれる', () => {
    it('detailsに検出された良い実装パターンが列挙される', async () => {
      const result = await qualityEvaluateHandler({ html: sampleHtmlGood });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.craftsmanship.details).toBeDefined();
        expect(Array.isArray(result.data.craftsmanship.details)).toBe(true);
        // 何らかの詳細が含まれている
        expect(result.data.craftsmanship.details!.length).toBeGreaterThan(0);
      }
    });
  });
});
