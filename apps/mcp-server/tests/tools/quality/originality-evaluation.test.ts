// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Originality評価ロジック改善テスト
 *
 * TDD Red フェーズ: 失敗するテストを先に作成
 *
 * 問題点:
 * 1. デフォルトスコアが100（常に満点スタート）
 * 2. details が空になる（評価根拠が不明）
 * 3. 「良い点」の記録が不足
 *
 * 改善後の期待動作:
 * 1. デフォルトスコアは80（中立的なスタート）
 * 2. details は必ず1つ以上の項目を含む
 * 3. HTML構造の良い点も記録する
 *
 * @module tests/tools/quality/originality-evaluation.test
 */

import { describe, it, expect } from 'vitest';

// =====================================================
// テスト用HTML定義
// =====================================================

/** 最小限のHTML（特徴がない） */
const MINIMAL_HTML = `
<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body><p>Hello</p></body>
</html>
`;

/** 標準的なHTML（クリシェなし、特別な特徴もなし） */
const STANDARD_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Standard Page</title>
</head>
<body>
  <header><nav><a href="/">Home</a></nav></header>
  <main><h1>Welcome</h1><p>Content here.</p></main>
  <footer><p>Footer</p></footer>
</body>
</html>
`;

/** カスタムスタイル使用HTML */
const CUSTOM_STYLE_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Custom Style Page</title>
  <style>
    :root {
      --brand-primary-color: #1a5f7a;
      --brand-secondary-color: #57c5b6;
      --brand-accent-color: #159895;
      --brand-text-color: #002b5b;
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .hero { animation: fadeIn 0.5s ease-in; }
    .container { color: var(--brand-text-color); }
    .button { background: var(--brand-primary-color); }
    .link { color: var(--brand-secondary-color); }
    .highlight { background: var(--brand-accent-color); }
    .card { border-color: var(--brand-primary-color); }
  </style>
</head>
<body>
  <main class="container">
    <section class="hero"><h1>Unique Design</h1></section>
  </main>
</body>
</html>
`;

/** AIクリシェを含むHTML */
const AI_CLICHE_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Transform Your Business</title>
  <style>
    .hero { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
    .cta { border-radius: 9999px; }
  </style>
</head>
<body>
  <div class="hero">
    <h1>Transform Your Business with AI</h1>
    <p>Unlock the power of cutting-edge solutions.</p>
    <button class="cta">Get Started Today</button>
  </div>
</body>
</html>
`;

// =====================================================
// テスト: Originality評価の基本動作
// =====================================================

describe('Originality評価ロジック改善', () => {
  describe('デフォルトスコア', () => {
    it('クリシェなし・特徴なしのHTMLでも100点にならない（80点が基準）', async () => {
      // 動的インポートでevaluateOriginality関数をテスト
      const { evaluateOriginality, detectCliches } = await import(
        '../../../src/tools/quality/evaluate.tool'
      );

      const cliches = detectCliches(MINIMAL_HTML, false);
      const result = evaluateOriginality(MINIMAL_HTML, cliches, false);

      // 改善後: デフォルトスコアは80（100ではない）
      expect(result.score).toBeLessThanOrEqual(85);
      expect(result.score).toBeGreaterThanOrEqual(75);
    });

    it('標準的なHTMLのスコアは80前後', async () => {
      const { evaluateOriginality, detectCliches } = await import(
        '../../../src/tools/quality/evaluate.tool'
      );

      const cliches = detectCliches(STANDARD_HTML, false);
      const result = evaluateOriginality(STANDARD_HTML, cliches, false);

      // 基準スコア80 ± ボーナス/ペナルティ
      expect(result.score).toBeGreaterThanOrEqual(75);
      expect(result.score).toBeLessThanOrEqual(90);
    });
  });

  describe('details（評価根拠）の必須出力', () => {
    it('detailsは必ず1つ以上の項目を含む（undefinedにならない）', async () => {
      const { evaluateOriginality, detectCliches } = await import(
        '../../../src/tools/quality/evaluate.tool'
      );

      const cliches = detectCliches(MINIMAL_HTML, false);
      const result = evaluateOriginality(MINIMAL_HTML, cliches, false);

      // 改善後: detailsは必ず存在する
      expect(result.details).toBeDefined();
      expect(Array.isArray(result.details)).toBe(true);
      expect(result.details!.length).toBeGreaterThanOrEqual(1);
    });

    it('標準的なHTMLでもdetailsが空にならない', async () => {
      const { evaluateOriginality, detectCliches } = await import(
        '../../../src/tools/quality/evaluate.tool'
      );

      const cliches = detectCliches(STANDARD_HTML, false);
      const result = evaluateOriginality(STANDARD_HTML, cliches, false);

      expect(result.details).toBeDefined();
      expect(result.details!.length).toBeGreaterThanOrEqual(1);
    });

    it('評価根拠には「基準スコア」の説明が含まれる', async () => {
      const { evaluateOriginality, detectCliches } = await import(
        '../../../src/tools/quality/evaluate.tool'
      );

      const cliches = detectCliches(MINIMAL_HTML, false);
      const result = evaluateOriginality(MINIMAL_HTML, cliches, false);

      // 基準スコアの説明が含まれる
      const hasBaseScoreExplanation = result.details!.some(
        (d) => d.includes('基準') || d.includes('ベース') || d.includes('標準')
      );
      expect(hasBaseScoreExplanation).toBe(true);
    });
  });

  describe('ボーナス評価の強化', () => {
    it('カスタムカラーパレット使用でボーナス加点', async () => {
      const { evaluateOriginality, detectCliches } = await import(
        '../../../src/tools/quality/evaluate.tool'
      );

      const cliches = detectCliches(CUSTOM_STYLE_HTML, false);
      const result = evaluateOriginality(CUSTOM_STYLE_HTML, cliches, false);

      // カスタムスタイル使用でボーナス
      expect(result.score).toBeGreaterThan(80);
      expect(result.details).toContain('独自のカラーパレット使用');
    });

    it('カスタムアニメーション使用でボーナス加点', async () => {
      const { evaluateOriginality, detectCliches } = await import(
        '../../../src/tools/quality/evaluate.tool'
      );

      const cliches = detectCliches(CUSTOM_STYLE_HTML, false);
      const result = evaluateOriginality(CUSTOM_STYLE_HTML, cliches, false);

      expect(result.details).toContain('カスタムアニメーション使用');
    });

    it('CSS変数活用でボーナス加点', async () => {
      const { evaluateOriginality, detectCliches } = await import(
        '../../../src/tools/quality/evaluate.tool'
      );

      const cliches = detectCliches(CUSTOM_STYLE_HTML, false);
      const result = evaluateOriginality(CUSTOM_STYLE_HTML, cliches, false);

      expect(result.details).toContain('CSS変数を活用');
    });
  });

  describe('クリシェ検出によるペナルティ', () => {
    it('AIクリシェ検出で減点される', async () => {
      const { evaluateOriginality, detectCliches } = await import(
        '../../../src/tools/quality/evaluate.tool'
      );

      const cliches = detectCliches(AI_CLICHE_HTML, false);
      const result = evaluateOriginality(AI_CLICHE_HTML, cliches, false);

      // クリシェ検出で減点
      expect(result.score).toBeLessThan(80);
      expect(cliches.detected).toBe(true);
      expect(cliches.count).toBeGreaterThan(0);
    });

    it('strictモードでより厳しく減点される', async () => {
      const { evaluateOriginality, detectCliches } = await import(
        '../../../src/tools/quality/evaluate.tool'
      );

      const clichesNormal = detectCliches(AI_CLICHE_HTML, false);
      const clichesStrict = detectCliches(AI_CLICHE_HTML, true);

      const resultNormal = evaluateOriginality(AI_CLICHE_HTML, clichesNormal, false);
      const resultStrict = evaluateOriginality(AI_CLICHE_HTML, clichesStrict, true);

      // strictモードの方が減点が大きい
      expect(resultStrict.score).toBeLessThan(resultNormal.score);
    });

    it('クリシェ検出時はdetailsに検出理由が含まれる', async () => {
      const { evaluateOriginality, detectCliches } = await import(
        '../../../src/tools/quality/evaluate.tool'
      );

      const cliches = detectCliches(AI_CLICHE_HTML, true);
      const result = evaluateOriginality(AI_CLICHE_HTML, cliches, true);

      // クリシェの検出理由がdetailsに含まれる
      const hasClicheDetail = result.details!.some((d) => d.includes('クリシェ'));
      expect(hasClicheDetail).toBe(true);
    });
  });

  describe('グレード判定', () => {
    it('スコア90以上でグレードA', async () => {
      const { evaluateOriginality, detectCliches } = await import(
        '../../../src/tools/quality/evaluate.tool'
      );

      // カスタムスタイル（ボーナス多い）でAグレードを狙う
      const cliches = detectCliches(CUSTOM_STYLE_HTML, false);
      const result = evaluateOriginality(CUSTOM_STYLE_HTML, cliches, false);

      if (result.score >= 90) {
        expect(result.grade).toBe('A');
      }
    });

    it('スコア80-89でグレードB', async () => {
      const { evaluateOriginality, detectCliches } = await import(
        '../../../src/tools/quality/evaluate.tool'
      );

      const cliches = detectCliches(STANDARD_HTML, false);
      const result = evaluateOriginality(STANDARD_HTML, cliches, false);

      if (result.score >= 80 && result.score < 90) {
        expect(result.grade).toBe('B');
      }
    });
  });
});
