// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SectionClassifier
 *
 * 検出されたセクションを精度高く分類するクラス
 * ルールベースの分類とコンテキスト考慮分類をサポート
 *
 * @module @reftrix/webdesign-core/section-classifier
 */

import type {
  DetectedSection,
  SectionType,
  SectionContent,
  SectionStyle,
  PositionInfo,
} from '../types/section.types';
import type {
  ClassificationRule,
  ClassificationCondition,
  ClassificationResult,
  ContextualClassificationResult,
  RangeValue,
} from './rules';
import { defaultRules } from './rules';

// Re-export types
export type {
  ClassificationRule,
  ClassificationCondition,
  ClassificationResult,
  ContextualClassificationResult,
  RangeValue,
} from './rules';

// =========================================
// Helper Functions
// =========================================

/**
 * 正規表現かどうかを判定
 */
function isRegExp(value: unknown): value is RegExp {
  return value instanceof RegExp;
}

/**
 * RangeValueかどうかを判定
 */
function isRangeValue(value: unknown): value is RangeValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('startY' in value || 'endY' in value || 'height' in value)
  );
}

/**
 * 配列かどうかを判定
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * コンテンツの特定の要素をチェック
 */
function checkContentHas(content: SectionContent, key: string): boolean {
  switch (key) {
    case 'h1':
      return content.headings.some((h) => h.level === 1);
    case 'h2':
      return content.headings.some((h) => h.level === 2);
    case 'button':
      return content.buttons.length > 0;
    case 'links':
      return content.links.length > 0;
    case 'images':
      return content.images.length > 0;
    case 'headings':
      return content.headings.length > 0;
    case 'paragraphs':
      return content.paragraphs.length > 0;
    case 'multipleHeadings':
      return content.headings.length >= 2;
    case 'multipleImages':
      return content.images.length >= 2;
    case 'manyImages':
      return content.images.length >= 4;
    case 'logo':
      return content.images.some(
        (img) => img.alt?.toLowerCase().includes('logo') || img.src.toLowerCase().includes('logo')
      );
    case 'copyright':
      return content.paragraphs.some(
        (p) =>
          p.includes('©') || p.toLowerCase().includes('copyright') || p.toLowerCase().includes('all rights reserved')
      );
    case 'email':
      return content.paragraphs.some((p) => p.includes('@') || p.toLowerCase().includes('email'));
    default:
      return false;
  }
}

/**
 * スタイルの特定の要素をチェック
 */
function checkStyleHas(style: SectionStyle, key: string): boolean {
  switch (key) {
    case 'backgroundImage':
      return style.hasImage === true;
    case 'gradient':
      return style.hasGradient === true;
    case 'backgroundColor':
      return !!style.backgroundColor;
    case 'textColor':
      return !!style.textColor;
    default:
      return false;
  }
}

/**
 * 位置が範囲内かどうかをチェック
 */
function checkPositionInRange(position: PositionInfo, range: RangeValue): boolean {
  if (range.startY) {
    const [min, max] = range.startY;
    if (position.startY < min || position.startY > max) {
      return false;
    }
  }
  if (range.endY) {
    const [min, max] = range.endY;
    if (position.endY < min || position.endY > max) {
      return false;
    }
  }
  if (range.height) {
    const [min, max] = range.height;
    if (position.height < min || position.height > max) {
      return false;
    }
  }
  return true;
}

/**
 * 条件を評価
 */
function evaluateCondition(
  condition: ClassificationCondition,
  section: DetectedSection
): { matches: boolean; weight: number } {
  const { field, operator, value, weight } = condition;

  let matches = false;

  switch (field) {
    case 'tagName':
      if (operator === 'equals' && typeof value === 'string') {
        matches = section.element.tagName.toLowerCase() === value.toLowerCase();
      } else if (operator === 'matches' && isRegExp(value)) {
        matches = value.test(section.element.tagName);
      }
      break;

    case 'classes': {
      const classString = section.element.classes.join(' ');
      if (operator === 'contains' && typeof value === 'string') {
        matches = section.element.classes.some((c) =>
          c.toLowerCase().includes(value.toLowerCase())
        );
      } else if (operator === 'matches' && isRegExp(value)) {
        matches = value.test(classString);
      } else if (operator === 'hasAny' && isStringArray(value)) {
        matches = value.some((v) =>
          section.element.classes.some((c) => c.toLowerCase().includes(v.toLowerCase()))
        );
      } else if (operator === 'hasAll' && isStringArray(value)) {
        matches = value.every((v) =>
          section.element.classes.some((c) => c.toLowerCase().includes(v.toLowerCase()))
        );
      }
      break;
    }

    case 'id':
      if (section.element.id) {
        if (operator === 'equals' && typeof value === 'string') {
          matches = section.element.id.toLowerCase() === value.toLowerCase();
        } else if (operator === 'matches' && isRegExp(value)) {
          matches = value.test(section.element.id);
        } else if (operator === 'contains' && typeof value === 'string') {
          matches = section.element.id.toLowerCase().includes(value.toLowerCase());
        }
      }
      break;

    case 'content':
      if (operator === 'hasAny' && isStringArray(value)) {
        matches = value.some((v) => checkContentHas(section.content, v));
      } else if (operator === 'hasAll' && isStringArray(value)) {
        matches = value.every((v) => checkContentHas(section.content, v));
      }
      break;

    case 'position':
      if (operator === 'range' && isRangeValue(value)) {
        matches = checkPositionInRange(section.position, value);
      }
      break;

    case 'style':
      if (operator === 'hasAny' && isStringArray(value)) {
        matches = value.some((v) => checkStyleHas(section.style, v));
      } else if (operator === 'hasAll' && isStringArray(value)) {
        matches = value.every((v) => checkStyleHas(section.style, v));
      }
      break;
  }

  return { matches, weight: matches ? weight : 0 };
}

/**
 * ルールを評価
 */
function evaluateRule(
  rule: ClassificationRule,
  section: DetectedSection
): { type: SectionType; confidence: number } | null {
  let totalWeight = 0;
  let matchedWeight = 0;

  for (const condition of rule.conditions) {
    totalWeight += condition.weight;
    const result = evaluateCondition(condition, section);
    matchedWeight += result.weight;
  }

  // 信頼度を計算
  const confidence = totalWeight > 0 ? matchedWeight / totalWeight : 0;

  // 最小信頼度を満たしているかチェック
  if (confidence >= rule.minConfidence) {
    return { type: rule.type, confidence: Math.min(confidence, 1) };
  }

  return null;
}

// =========================================
// SectionClassifier Class
// =========================================

/**
 * SectionClassifier クラス
 *
 * セクションの分類を行う
 */
export class SectionClassifier {
  private rules: ClassificationRule[];

  /**
   * コンストラクタ
   * @param customRules カスタムルール（省略時はデフォルトルールを使用）
   */
  constructor(customRules?: ClassificationRule[]) {
    this.rules = customRules ? [...customRules] : [...defaultRules];
    // 優先度でソート（降順）
    this.sortRules();
  }

  /**
   * ルールを優先度でソート
   */
  private sortRules(): void {
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * デフォルトルールを取得
   */
  getDefaultRules(): ClassificationRule[] {
    return [...this.rules];
  }

  /**
   * カスタムルールを追加
   */
  addRule(rule: ClassificationRule): void {
    this.rules.push(rule);
    this.sortRules();
  }

  /**
   * 単一セクションを分類
   */
  classify(section: DetectedSection): ClassificationResult {
    const results: Array<{ type: SectionType; confidence: number; priority: number }> = [];

    // すべてのルールを評価
    for (const rule of this.rules) {
      const result = evaluateRule(rule, section);
      if (result) {
        results.push({ ...result, priority: rule.priority });
      }
    }

    // 結果がない場合は unknown を返す
    if (results.length === 0) {
      return { type: 'unknown', confidence: 0 };
    }

    // 優先度 -> 信頼度 の順でソートして最良の結果を取得
    results.sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      return b.confidence - a.confidence;
    });

    const best = results[0];
    if (!best) {
      return { type: 'unknown', confidence: 0 };
    }

    return { type: best.type, confidence: best.confidence };
  }

  /**
   * 複数セクションをコンテキストを考慮して分類
   */
  classifyWithContext(
    sections: DetectedSection[]
  ): ContextualClassificationResult[] {
    if (sections.length === 0) {
      return [];
    }

    // まず各セクションを個別に分類
    const individualResults = sections.map((section) => ({
      section,
      ...this.classify(section),
    }));

    // コンテキストを考慮した補正
    const contextualResults = this.applyContextualBoosts(individualResults, sections);

    return contextualResults;
  }

  /**
   * コンテキストに基づいた信頼度補正
   */
  private applyContextualBoosts(
    results: ContextualClassificationResult[],
    sections: DetectedSection[]
  ): ContextualClassificationResult[] {
    if (results.length === 0) {
      return results;
    }

    const boostedResults = [...results];
    const totalSections = sections.length;

    for (let i = 0; i < boostedResults.length; i++) {
      const result = boostedResults[i];
      if (!result) continue;
      const section = result.section;

      // 1. 先頭セクションのナビゲーション/ヒーロー補正
      if (i === 0) {
        if (result.type === 'unknown' || result.confidence < 0.5) {
          // リンクが多い場合はナビゲーション
          if (section.content.links.length >= 3) {
            result.type = 'navigation';
            result.confidence = Math.max(result.confidence, 0.6);
          }
          // h1とボタンがある場合はヒーロー
          else if (
            section.content.headings.some((h) => h.level === 1) &&
            section.content.buttons.length > 0
          ) {
            result.type = 'hero';
            result.confidence = Math.max(result.confidence, 0.6);
          }
        }
        // すでにナビゲーションかヒーローの場合は信頼度ブースト
        if (result.type === 'navigation' || result.type === 'hero') {
          result.confidence = Math.min(result.confidence * 1.1, 1);
        }
      }

      // 2. 2番目のセクションがヒーローの可能性（最初がナビゲーションの場合）
      const firstResult = boostedResults[0];
      if (i === 1 && firstResult && firstResult.type === 'navigation') {
        if (
          result.type === 'unknown' &&
          section.content.headings.some((h) => h.level === 1) &&
          section.content.buttons.length > 0
        ) {
          result.type = 'hero';
          result.confidence = Math.max(result.confidence, 0.7);
        }
      }

      // 3. 末尾セクションのフッター補正
      if (i === totalSections - 1) {
        if (result.type === 'unknown' || result.confidence < 0.5) {
          // 著作権テキストがある場合
          const hasCopyright = section.content.paragraphs.some(
            (p) =>
              p.includes('©') ||
              p.toLowerCase().includes('copyright') ||
              p.toLowerCase().includes('all rights reserved')
          );
          if (hasCopyright) {
            result.type = 'footer';
            result.confidence = Math.max(result.confidence, 0.8);
          }
          // フッター要素がある場合
          else if (section.element.tagName === 'footer') {
            result.type = 'footer';
            result.confidence = Math.max(result.confidence, 0.9);
          }
        }
        // すでにフッターの場合は信頼度ブースト
        if (result.type === 'footer') {
          result.confidence = Math.min(result.confidence * 1.1, 1);
        }
      }

      // 4. 連続するフィーチャーセクションのグループ化補正
      if (i > 0 && i < totalSections - 1) {
        const prevResult = boostedResults[i - 1];
        // 前のセクションがフィーチャーで、現在も似た構造の場合
        if (prevResult && prevResult.type === 'feature') {
          // 同様のコンテンツ構造（見出し+画像）を持つ場合
          if (
            section.content.headings.length >= 2 ||
            section.content.images.length >= 2
          ) {
            if (result.type === 'unknown' || result.confidence < 0.5) {
              result.type = 'feature';
              result.confidence = Math.max(result.confidence, 0.6);
            }
          }
        }
      }

      // 5. 典型的なLP構成パターンの検出
      this.applyLPPatternBoosts(boostedResults, i);
    }

    return boostedResults;
  }

  /**
   * 典型的なLP構成パターンに基づく補正
   */
  private applyLPPatternBoosts(
    results: ContextualClassificationResult[],
    currentIndex: number
  ): void {
    // 典型的なLP構成: nav -> hero -> feature -> testimonial/pricing -> cta -> footer
    // このパターンを参考に、ページ位置に基づいて分類を補正する

    const result = results[currentIndex];
    if (!result) return;

    // 現在の位置に基づいて期待されるタイプを推測
    if (result.type === 'unknown' && result.confidence < 0.3) {
      const normalizedPosition = currentIndex / (results.length - 1 || 1);

      // 先頭付近（0-0.15）
      if (normalizedPosition <= 0.15) {
        // ナビゲーションかヒーローの可能性が高い
        if (result.section.content.links.length >= 2) {
          result.type = 'navigation';
          result.confidence = 0.4;
        }
      }
      // 序盤（0.15-0.3）
      else if (normalizedPosition <= 0.3) {
        // ヒーローかフィーチャーの可能性が高い
        if (
          result.section.content.headings.some((h) => h.level === 1) &&
          result.section.content.buttons.length > 0
        ) {
          result.type = 'hero';
          result.confidence = 0.5;
        }
      }
      // 中盤（0.3-0.7）
      else if (normalizedPosition <= 0.7) {
        // フィーチャー、テスティモニアル、プライシングの可能性
        if (result.section.content.images.length >= 3) {
          result.type = 'feature';
          result.confidence = 0.4;
        }
      }
      // 終盤（0.7-0.9）
      else if (normalizedPosition <= 0.9) {
        // CTAの可能性
        if (result.section.content.buttons.length > 0) {
          result.type = 'cta';
          result.confidence = 0.4;
        }
      }
      // 末尾付近（0.9-1.0）
      else {
        // フッターの可能性が高い
        const hasCopyright = result.section.content.paragraphs.some(
          (p) =>
            p.includes('©') ||
            p.toLowerCase().includes('copyright') ||
            p.toLowerCase().includes('all rights reserved')
        );
        if (hasCopyright || result.section.element.tagName === 'footer') {
          result.type = 'footer';
          result.confidence = 0.6;
        }
      }
    }
  }
}
