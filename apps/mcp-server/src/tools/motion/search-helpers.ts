// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.search 検索ヘルパーモジュール
 * パターン変換、多様性フィルタリング（MMR）、実装コード付与を提供します。
 *
 * @module tools/motion/search-helpers
 */

import { logger, isDevelopment } from "../../utils/logger";
import { formatDuration } from "./code-generators";

import type {
  MotionPatternInput,
  MotionSearchResultItem,
  MotionImplementation,
  MotionPattern,
  MotionCategory,
} from "./schemas";

// =====================================================
// 実装コード生成ヘルパー（v0.1.0: include_implementation用）
// =====================================================

/**
 * MotionTypeをMotionPatternInput用のtypeに変換
 * @param type MotionType
 * @returns MotionPatternInputType
 */
function mapMotionType(type: MotionPattern["type"]): MotionPatternInput["type"] {
  switch (type) {
    case "css_animation":
    case "library_animation":
    case "video_motion":
      return "animation";
    case "css_transition":
      return "transition";
    case "keyframes":
      return "keyframe";
    default:
      return "animation";
  }
}

/**
 * MotionPatternからMotionPatternInputに変換
 * @param pattern 検索結果のパターン
 * @returns コード生成用のパターン入力
 */
function patternToPatternInput(pattern: MotionPattern): MotionPatternInput {
  // animationオブジェクトから値を抽出、easingはオブジェクトの可能性あり
  const duration = pattern.animation?.duration ?? 300;
  const easingConfig = pattern.animation?.easing;
  // easingConfigがオブジェクトの場合はtypeまたはcubicBezierを使用
  let easing = "ease";
  if (easingConfig) {
    if (easingConfig.cubicBezier) {
      easing = `cubic-bezier(${easingConfig.cubicBezier.join(", ")})`;
    } else if (easingConfig.type && easingConfig.type !== "cubic-bezier") {
      easing = easingConfig.type;
    }
  }
  const delay = pattern.animation?.delay ?? 0;
  const iterations = pattern.animation?.iterations ?? 1;
  const direction = pattern.animation?.direction ?? "normal";
  const fillMode = pattern.animation?.fillMode ?? "none";

  return {
    type: mapMotionType(pattern.type),
    name: pattern.name ?? "unnamed",
    duration,
    delay,
    easing,
    iterations,
    direction,
    fillMode,
    // propertiesのpropertyをnameに変換
    properties: pattern.properties?.map((p) => ({
      name: p.property ?? "opacity",
      from: String(p.from ?? "0"),
      to: String(p.to ?? "1"),
    })) ?? [{ name: "opacity", from: "0", to: "1" }],
  };
}

/**
 * 検索結果のパターンから実装コード情報を生成
 * @param pattern 検索結果のパターン
 * @returns 実装コード情報
 */
function generateImplementationForPattern(pattern: MotionPattern): MotionImplementation {
  const patternInput = patternToPatternInput(pattern);
  const implementation: MotionImplementation = {};

  // transitionタイプの場合（css_transition）
  if (pattern.type === "css_transition") {
    const props = patternInput.properties.map((p) => p.name).join(", ");
    implementation.transition = `transition: ${props} ${formatDuration(patternInput.duration)} ${patternInput.easing};`;
    return implementation;
  }

  // animation/@keyframesタイプの場合
  // @keyframes生成
  const keyframeLines: string[] = [];
  keyframeLines.push(`@keyframes ${pattern.name} {`);
  keyframeLines.push("  from {");
  for (const prop of patternInput.properties) {
    keyframeLines.push(`    ${prop.name}: ${prop.from};`);
  }
  keyframeLines.push("  }");
  keyframeLines.push("  to {");
  for (const prop of patternInput.properties) {
    keyframeLines.push(`    ${prop.name}: ${prop.to};`);
  }
  keyframeLines.push("  }");
  keyframeLines.push("}");
  implementation.keyframes = keyframeLines.join("\n");

  // animationプロパティ生成
  implementation.animation = `animation: ${pattern.name} ${formatDuration(patternInput.duration)} ${patternInput.easing};`;

  // Tailwindクラス生成
  implementation.tailwind = `animate-${pattern.name}`;

  return implementation;
}

// =====================================================
// 多様性フィルタリング (MMR強化)
// =====================================================

/**
 * 2つの文字列の類似度を計算（Levenshtein距離ベース）
 * @param a 比較元文字列
 * @param b 比較先文字列
 * @returns 類似度 (0.0-1.0)
 */
function calculateNameSimilarity(a: string | undefined, b: string | undefined): number {
  if (!a || !b) {
    return 0;
  }
  const normalizedA = a.toLowerCase().replace(/[-_\s]/g, "");
  const normalizedB = b.toLowerCase().replace(/[-_\s]/g, "");

  if (normalizedA === normalizedB) {
    return 1.0;
  }

  // 共通のプレフィックスをチェック（例: fadeIn, fadeInUp → 高い類似度）
  let commonPrefixLen = 0;
  const minLen = Math.min(normalizedA.length, normalizedB.length);
  for (let i = 0; i < minLen; i++) {
    if (normalizedA[i] === normalizedB[i]) {
      commonPrefixLen++;
    } else {
      break;
    }
  }

  // プレフィックス類似度（4文字以上の共通プレフィックスで高い類似度）
  if (commonPrefixLen >= 4) {
    return 0.6 + 0.4 * (commonPrefixLen / Math.max(normalizedA.length, normalizedB.length));
  }

  // 部分文字列チェック
  if (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)) {
    return 0.7;
  }

  return 0;
}

/**
 * 2つのモーションパターン間の類似度を計算
 * 名前、カテゴリ、トリガー、アニメーション設定を比較
 * @param a 比較元パターン
 * @param b 比較先パターン
 * @returns 類似度 (0.0-1.0)
 */
function calculatePatternSimilarity(a: MotionSearchResultItem, b: MotionSearchResultItem): number {
  let similarityScore = 0;
  let weightTotal = 0;

  // 名前の類似度 (重み: 0.25) - v0.1.0追加
  const nameWeight = 0.25;
  const nameSimilarity = calculateNameSimilarity(a.pattern.name, b.pattern.name);
  similarityScore += nameWeight * nameSimilarity;
  weightTotal += nameWeight;

  // カテゴリの一致 (重み: 0.25)
  const categoryWeight = 0.25;
  if (a.pattern.category === b.pattern.category) {
    similarityScore += categoryWeight;
  }
  weightTotal += categoryWeight;

  // トリガーの一致 (重み: 0.15)
  const triggerWeight = 0.15;
  if (a.pattern.trigger === b.pattern.trigger) {
    similarityScore += triggerWeight;
  }
  weightTotal += triggerWeight;

  // タイプの一致 (重み: 0.1)
  const typeWeight = 0.1;
  if (a.pattern.type === b.pattern.type) {
    similarityScore += typeWeight;
  }
  weightTotal += typeWeight;

  // duration類似度 (重み: 0.1)
  const durationWeight = 0.1;
  const durationA = a.pattern.animation?.duration ?? 0;
  const durationB = b.pattern.animation?.duration ?? 0;
  if (durationA > 0 && durationB > 0) {
    const durationRatio = Math.min(durationA, durationB) / Math.max(durationA, durationB);
    similarityScore += durationWeight * durationRatio;
  } else if (durationA === 0 && durationB === 0) {
    similarityScore += durationWeight;
  }
  weightTotal += durationWeight;

  // easing類似度 (重み: 0.075)
  const easingWeight = 0.075;
  const easingA = a.pattern.animation?.easing?.type ?? "unknown";
  const easingB = b.pattern.animation?.easing?.type ?? "unknown";
  if (easingA === easingB) {
    similarityScore += easingWeight;
  }
  weightTotal += easingWeight;

  // プロパティ類似度 (重み: 0.075)
  const propertiesWeight = 0.075;
  const propsA = new Set(a.pattern.properties?.map((p) => p.property) ?? []);
  const propsB = new Set(b.pattern.properties?.map((p) => p.property) ?? []);
  if (propsA.size > 0 && propsB.size > 0) {
    const intersection = [...propsA].filter((p) => propsB.has(p)).length;
    const union = new Set([...propsA, ...propsB]).size;
    similarityScore += propertiesWeight * (intersection / union);
  } else if (propsA.size === 0 && propsB.size === 0) {
    similarityScore += propertiesWeight;
  }
  weightTotal += propertiesWeight;

  return weightTotal > 0 ? similarityScore / weightTotal : 0;
}

/**
 * MMR (Maximal Marginal Relevance) アルゴリズムで多様性フィルタリングを適用
 *
 * MMRスコア = λ * relevance - (1-λ) * max_similarity_to_selected
 *
 * @param results 検索結果配列（類似度順）
 * @param lambda λ値（0.0-1.0）- 0.0で最大多様性、1.0で関連度のみ
 * @param ensureCategoryDiversity カテゴリ分散を強制するか
 * @param limit 最大結果数
 * @returns フィルタリング後の検索結果
 */
export function applyDiversityFilter(
  results: MotionSearchResultItem[],
  lambda: number,
  ensureCategoryDiversity: boolean,
  limit: number
): MotionSearchResultItem[] {
  if (results.length === 0) {
    return results;
  }

  // λ=1.0 の場合、多様性フィルタなし（関連度順のまま）
  if (lambda >= 1.0) {
    return results.slice(0, limit);
  }

  // λ=0.0 かつ ensureCategoryDiversity=false の場合、類似度順でフィルタリングのみ
  // ただし、同一名パターンは除外
  if (lambda <= 0.0 && !ensureCategoryDiversity) {
    const selected: MotionSearchResultItem[] = [];
    const usedNames = new Set<string>();

    for (const result of results) {
      if (selected.length >= limit) break;

      const name = result.pattern.name?.toLowerCase() ?? "";
      if (!usedNames.has(name)) {
        selected.push(result);
        if (name) usedNames.add(name);
      }
    }
    return selected;
  }

  // MMRアルゴリズムによる選択
  const selected: MotionSearchResultItem[] = [];
  const remaining = [...results];
  const usedCategories = new Map<MotionCategory, number>();

  while (remaining.length > 0 && selected.length < limit) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      if (!candidate) continue;

      // 関連度スコア（検索結果の類似度）
      const relevance = candidate.similarity;

      // 選択済み結果との最大類似度を計算
      let maxSimilarityToSelected = 0;
      for (const sel of selected) {
        const sim = calculatePatternSimilarity(sel, candidate);
        if (sim > maxSimilarityToSelected) {
          maxSimilarityToSelected = sim;
        }
      }

      // MMRスコア計算: λ * relevance - (1-λ) * max_similarity_to_selected
      let mmrScore = lambda * relevance - (1 - lambda) * maxSimilarityToSelected;

      // カテゴリ分散ボーナス（ensureCategoryDiversity=true の場合）
      if (ensureCategoryDiversity) {
        const category = candidate.pattern.category;
        const categoryCount = usedCategories.get(category) ?? 0;

        // 未使用カテゴリにはボーナス
        if (categoryCount === 0) {
          mmrScore += 0.1;
        } else if (categoryCount >= 2) {
          // 同一カテゴリ3件以上は大きくペナルティ
          mmrScore -= 0.2 * categoryCount;
        }
      }

      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    // 最良候補を選択
    const chosenItem = remaining.splice(bestIdx, 1)[0];
    if (!chosenItem) break;
    selected.push(chosenItem);

    // カテゴリカウントを更新
    const category = chosenItem.pattern.category;
    usedCategories.set(category, (usedCategories.get(category) ?? 0) + 1);
  }

  if (isDevelopment()) {
    logger.info("[MCP Tool] motion.search MMR diversity filter applied", {
      originalCount: results.length,
      filteredCount: selected.length,
      lambda,
      ensureCategoryDiversity,
      categoryDistribution: Object.fromEntries(usedCategories),
    });
  }

  return selected;
}

/**
 * 検索結果に実装コードを付与
 * @param results 検索結果配列
 * @returns 実装コードが付与された検索結果
 */
export function enrichResultsWithImplementation(
  results: MotionSearchResultItem[]
): MotionSearchResultItem[] {
  return results.map((result) => ({
    ...result,
    implementation: generateImplementationForPattern(result.pattern),
  }));
}
