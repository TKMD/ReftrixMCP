// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Style Embedding Integration Tests
 *
 * スタイル特徴量から埋め込み生成までのフルフローをテスト
 * 1. 特徴量抽出
 * 2. 特徴量 -> テキスト表現
 * 3. テキスト表現 -> StyleEmbeddingService -> 768次元ベクトル
 *
 * @see packages/ml/src/embeddings/style-embedding.service.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { StyleEmbeddingService } from '../src/embeddings/style-embedding.service';

// このテストではサンプルテキストを直接使用して統合フローをシミュレートします

describe('Style Embedding Integration', () => {
  let embeddingService: StyleEmbeddingService;

  beforeAll(() => {
    embeddingService = new StyleEmbeddingService();
  });

  // ==========================================================================
  // フルフロー統合テスト（シミュレーション）
  // ==========================================================================
  describe('full flow simulation', () => {
    it('should generate embedding from simulated style text (thin stroke icon)', async () => {
      // StyleFeaturesToTextで生成されるようなテキストをシミュレート
      const styleText = 'Design style: thin stroke (1px) consistent outlined simple complexity 1 paths square';

      const embedding = await embeddingService.generateEmbedding(styleText);

      // 768次元の正規化済みベクトル
      expect(embedding.length).toBe(768);
      const l2Norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
      expect(l2Norm).toBeCloseTo(1.0, 4);
    });

    it('should generate embedding from simulated style text (filled icon)', async () => {
      const styleText = 'Design style: filled simple complexity 1 paths square';

      const embedding = await embeddingService.generateEmbedding(styleText);

      expect(embedding.length).toBe(768);
    });

    it('should generate embedding from simulated style text (complex illustration)', async () => {
      const styleText = 'Design style: mixed complex complexity 30 paths detailed wide';

      const embedding = await embeddingService.generateEmbedding(styleText);

      expect(embedding.length).toBe(768);
    });
  });

  // ==========================================================================
  // 類似デザイン検索シナリオ
  // ==========================================================================
  describe('similar design search scenarios', () => {
    it('should find similar icons by style (thin stroke family)', async () => {
      // Thin stroke アイコンファミリー
      const thinArrow = 'Design style: thin stroke (1px) consistent outlined simple complexity 1 paths square';
      const thinHome = 'Design style: thin stroke (0.75px) consistent outlined simple complexity 3 paths square';
      const thinSearch = 'Design style: thin stroke (0.5px) consistent outlined simple complexity 2 paths square';

      // 太い stroke の異なるスタイル
      const thickIcon = 'Design style: thick stroke (3px) consistent outlined medium complexity 5 paths square';

      // 埋め込み生成
      const [embThinArrow, embThinHome, embThinSearch, embThickIcon] = await Promise.all([
        embeddingService.generateEmbedding(thinArrow),
        embeddingService.generateEmbedding(thinHome),
        embeddingService.generateEmbedding(thinSearch),
        embeddingService.generateEmbedding(thickIcon),
      ]);

      // 類似度計算
      const simArrowHome = cosineSimilarity(embThinArrow, embThinHome);
      const simArrowSearch = cosineSimilarity(embThinArrow, embThinSearch);
      const simArrowThick = cosineSimilarity(embThinArrow, embThickIcon);

      // Thin stroke ファミリー内の類似度は高い（> 0.85）
      expect(simArrowHome).toBeGreaterThan(0.85);
      expect(simArrowSearch).toBeGreaterThan(0.85);

      // Thin vs Thick の類似度は相対的に低い
      // （ただし「Design style:」プレフィックスの共通性があるため、絶対値は高め）
      expect(simArrowThick).toBeLessThan(simArrowHome);
    });

    it('should distinguish filled vs outlined icons', async () => {
      const filledHeart = 'Design style: filled simple complexity 1 paths square';
      const outlinedHeart = 'Design style: thin stroke (1.5px) consistent outlined simple complexity 1 paths square';
      const filledStar = 'Design style: filled simple complexity 1 paths square';

      const [embFilledHeart, embOutlinedHeart, embFilledStar] = await Promise.all([
        embeddingService.generateEmbedding(filledHeart),
        embeddingService.generateEmbedding(outlinedHeart),
        embeddingService.generateEmbedding(filledStar),
      ]);

      // 同じスタイル（filled）同士は類似度が高い
      const simFilledHeartStar = cosineSimilarity(embFilledHeart, embFilledStar);
      // 異なるスタイル（filled vs outlined）は類似度が相対的に低い
      const simFilledOutlined = cosineSimilarity(embFilledHeart, embOutlinedHeart);

      // filled同士は非常に高い類似度（同じテキストだが）
      expect(simFilledHeartStar).toBeGreaterThan(0.99);
      // filled vs outlined は相対的に低い
      expect(simFilledOutlined).toBeLessThan(simFilledHeartStar);
    });

    it('should distinguish simple vs complex icons', async () => {
      const simpleIcon = 'Design style: thin stroke (1px) outlined simple complexity 1 paths square';
      const complexIllustration = 'Design style: mixed complex complexity 30 paths detailed wide';

      const [embSimple, embComplex] = await Promise.all([
        embeddingService.generateEmbedding(simpleIcon),
        embeddingService.generateEmbedding(complexIllustration),
      ]);

      const similarity = cosineSimilarity(embSimple, embComplex);

      // Simple vs Complex は類似度が相対的に低い（< 0.95）
      // Note: "Design style:" プレフィックスの共通性により絶対値は高め
      expect(similarity).toBeLessThan(0.95);
      // 但し十分に異なる（完全一致ではない）
      expect(similarity).toBeGreaterThan(0.85);
    });
  });

  // ==========================================================================
  // パフォーマンス統合テスト
  // ==========================================================================
  describe('performance requirements', () => {
    it('should complete full embedding generation in under 150ms (after warm-up)', async () => {
      // ウォームアップ
      await embeddingService.generateEmbedding('warmup text');

      const styleText = 'Design style: thin stroke (1px) consistent outlined simple complexity 5 paths square';

      const startTime = performance.now();
      await embeddingService.generateEmbedding(styleText);
      const elapsed = performance.now() - startTime;

      // 埋め込み生成のみで150ms未満（環境差を考慮し緩和）
      expect(elapsed).toBeLessThan(150);
    });

    it('should complete batch of 10 embeddings in under 1 second (after warm-up)', async () => {
      // ウォームアップ
      await embeddingService.generateBatchEmbeddings(['warmup']);

      const styleTexts = [
        'Design style: thin stroke outlined simple',
        'Design style: medium stroke outlined medium complexity',
        'Design style: thick stroke outlined complex',
        'Design style: filled simple square',
        'Design style: mixed medium complexity',
        'Design style: thin stroke filled simple',
        'Design style: thick stroke filled complex',
        'Design style: outlined simple rounded',
        'Design style: filled complex detailed',
        'Design style: mixed simple square',
      ];

      const startTime = performance.now();
      const embeddings = await embeddingService.generateBatchEmbeddings(styleTexts);
      const elapsed = performance.now() - startTime;

      expect(embeddings.length).toBe(10);
      expect(elapsed).toBeLessThan(1000);
    });
  });

  // ==========================================================================
  // クエリ埋め込みテスト
  // ==========================================================================
  describe('query embedding for search', () => {
    it('should generate query embedding for user search', async () => {
      const userQuery = 'thin stroke icon simple';

      const queryEmbedding = await embeddingService.generateQueryEmbedding(userQuery);

      expect(queryEmbedding.length).toBe(768);
    });

    it('should find relevant icons using query embedding', async () => {
      // ドキュメント（スタイルテキスト）の埋め込み
      const thinIcon = 'Design style: thin stroke (1px) consistent outlined simple complexity 1 paths square';
      const thickIcon = 'Design style: thick stroke (3px) consistent outlined complex complexity 20 paths wide';
      const filledIcon = 'Design style: filled medium complexity 10 paths square';

      // クエリ埋め込み
      const query = 'thin stroke simple icon';

      const [embThin, embThick, embFilled, embQuery] = await Promise.all([
        embeddingService.generateEmbedding(thinIcon),
        embeddingService.generateEmbedding(thickIcon),
        embeddingService.generateEmbedding(filledIcon),
        embeddingService.generateQueryEmbedding(query),
      ]);

      // クエリとの類似度
      const simQueryThin = cosineSimilarity(embQuery, embThin);
      const simQueryThick = cosineSimilarity(embQuery, embThick);
      const simQueryFilled = cosineSimilarity(embQuery, embFilled);

      // "thin stroke simple" クエリに最も近いのは thin icon
      expect(simQueryThin).toBeGreaterThan(simQueryThick);
      expect(simQueryThin).toBeGreaterThan(simQueryFilled);
    });
  });
});

// =============================================================================
// テストユーティリティ
// =============================================================================

/**
 * コサイン類似度を計算
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same dimension');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const aVal = a[i] ?? 0;
    const bVal = b[i] ?? 0;
    dotProduct += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) return 0;

  return dotProduct / (normA * normB);
}
